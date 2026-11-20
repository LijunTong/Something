<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton, NInput, NTag, NText,
  NBlockquote, NEmpty, NSpin, NUpload, NAvatar, NScrollbar,
  useMessage, useDialog
} from 'naive-ui'
import type { UploadCustomRequestOptions } from 'naive-ui'
import Shell from '@/components/Shell.vue'
import { call, bridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useAppStore } from '@/stores/app'
import type { FeedApi, FeedItem, FeedSource } from '@/types/api'
import '@/styles/feed.css'

type FeedKind = 'unread' | 'all' | 'starred' | 'later'

const router = useRouter()
const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
/** 订阅源管理统一在设置页：本页不再维护第二套表单 */
function goSettings() { void router.push({ path: '/settings', query: { panel: 'feed' } }) }

/** Api 接口暂未声明 feed 域时的局部适配；FeedApi 契约已存在，仍走 bridge()/call 的 IPC 路径 */
const feedBridge = (): FeedApi => (bridge() as unknown as { feed: FeedApi }).feed

/** 页面状态：筛选条件、选中文章、加载与弹窗开关均为 UI 态，不进 Pinia */
const groups = ref<Array<{ id: string; name: string }>>([])
const sources = ref<FeedSource[]>([])
const allItems = ref<FeedItem[]>([])
const kind = ref<FeedKind | ''>('unread')
const sourceId = ref('')
const groupId = ref('')
const selectedId = ref('')
const busy = ref(false)
const fontScale = ref(1)
const darkArticle = ref(false)
// 订阅源与分组的增删改统一在「设置 › 订阅源」维护，本页只负责阅读

/** 无 IPC 时的浏览器降级数据：字段名与 FeedItem / FeedSource 契约一致 */
const FALLBACK_GROUPS = [
  { id: 'grp-tech', name: '科技' },
  { id: 'grp-design', name: '设计' },
  { id: 'grp-blog', name: '独立博客' }
]
const now = Date.now()
const FALLBACK_SOURCES: FeedSource[] = [
  { id: 'src-1', url: 'https://sspai.com/feed', title: '少数派', groupId: 'grp-tech', intervalMin: 60, enabled: true, lastFetchAt: now - 600000 },
  { id: 'src-2', url: 'https://36kr.com/feed', title: '36氪', groupId: 'grp-tech', intervalMin: 60, enabled: true, lastFetchAt: now - 3600000 },
  { id: 'src-3', url: 'https://designweekly.com/rss', title: '设计周刊', groupId: 'grp-design', intervalMin: 360, enabled: true, lastFetchAt: now - 7200000 },
  { id: 'src-4', url: 'https://uxcollective.com/feed', title: 'UX Collective', groupId: 'grp-design', intervalMin: 360, enabled: true, lastFetchAt: now - 7200000 },
  { id: 'src-5', url: 'https://ruanyifeng.com/blog/rss', title: '阮一峰的网络日志', groupId: 'grp-blog', intervalMin: 1440, enabled: true, lastFetchAt: now - 86400000 },
  { id: 'src-6', url: 'https://independent.example/feed', title: '某独立博客', groupId: 'grp-blog', intervalMin: 1440, enabled: true, lastFetchAt: now - 86400000 }
]
const FALLBACK_ITEMS: FeedItem[] = [
  { id: 'it-1', sourceId: 'src-1', title: '本地优先软件的数据边界设计', link: 'https://sspai.com/local-first', author: '陈默', summary: '为什么本地优先正在重新成为个人工具的核心设计原则。', content: '本地优先不是把同步关掉，而是让本机数据成为唯一权威来源。\n\n网络只作为可选增强，应用在没有账号时仍然完整可用。', publishedAt: now - 600000, read: false, starred: false, readLater: false, sourceTitle: '少数派' },
  { id: 'it-2', sourceId: 'src-3', title: 'RSS 阅读工作流：从收集到归档', link: 'https://designweekly.com/rss-flow', author: '编辑部', summary: '一套可执行的订阅、稍后读与笔记联动方法。', content: '把收集、阅读与归档拆成三个独立动作。\n\n每个动作都有明确出口，信息才不会堆在收件箱里。', publishedAt: now - 3600000, read: false, starred: true, readLater: false, sourceTitle: '设计周刊' },
  { id: 'it-3', sourceId: 'src-2', title: '桌面效率工具的十二条交互准则', link: 'https://36kr.com/desktop-ux', author: '产品组', summary: '信息密度、快捷键与状态反馈的取舍。', content: '密度不是把东西塞满，而是让高频操作更近。\n\n状态反馈要出现在操作发生的地方。', publishedAt: now - 7200000, read: false, starred: false, readLater: true, sourceTitle: '36氪' },
  { id: 'it-4', sourceId: 'src-5', title: '每周科技新闻汇总（第 218 期）', link: 'https://ruanyifeng.com/weekly', author: '阮一峰', summary: '本周值得关注的开源项目与技术动态。', content: '本期收录了若干值得跟进的开源项目。\n\n其中桌面端本地数据库的变化尤其明显。', publishedAt: now - 18000000, read: true, starred: false, readLater: false, sourceTitle: '阮一峰的网络日志' },
  { id: 'it-5', sourceId: 'src-4', title: 'Designing for calm in productivity tools', link: 'https://uxcollective.com/calm', author: 'UX Collective', summary: 'How restraint and clarity beat feature creep in daily tools.', content: 'Restraint is a feature.\n\nClear states let people trust the tool without learning it.', publishedAt: now - 86400000, read: true, starred: true, readLater: false, sourceTitle: 'UX Collective' },
  { id: 'it-6', sourceId: 'src-6', title: '我的离线知识管理实践', link: 'https://independent.example/offline-km', author: '独立作者', summary: '用纯文本与本地搜索构建不被平台绑架的知识库。', content: '纯文本的好处是十年后仍能打开。\n\n本地搜索让检索速度不再依赖网络。', publishedAt: now - 90000000, read: true, starred: false, readLater: false, sourceTitle: '某独立博客' }
]
const smartNav = [
  { kind: 'all' as FeedKind, label: '全部文章', icon: 'i-list' },
  { kind: 'unread' as FeedKind, label: '未读', icon: 'i-inbox' },
  { kind: 'starred' as FeedKind, label: '收藏', icon: 'i-star' },
  { kind: 'later' as FeedKind, label: '稍后读', icon: 'i-clock' }
]
const freqOptions = [
  { label: '每小时', value: 60 },
  { label: '每 6 小时', value: 360 },
  { label: '每天', value: 1440 }
]

const unreadCount = computed(() => allItems.value.filter((i) => !i.read).length)
/** 最后抓取时间：取所有订阅源里最新的 lastFetchAt */
const lastFetchText = computed(() => {
  const latest = sources.value.reduce((max, s) => Math.max(max, s.lastFetchAt ?? 0), 0)
  return latest ? fmtAgo(latest) : '尚未抓取'
})
/** 按分组整理订阅源，供左侧导航按原型顺序渲染 */
const grouped = computed(() => groups.value.map((g) => ({
  ...g,
  sources: sources.value.filter((s) => s.groupId === g.id)
})))
const ungrouped = computed(() => sources.value.filter((s) => !s.groupId || !groups.value.some((g) => g.id === s.groupId)))
const groupOptions = computed(() => [
  { label: '未分组', value: '' },
  ...groups.value.map((g) => ({ label: g.name, value: g.id }))
])
/** 分类口径：未读 / 收藏 / 稍后读；空值表示不过滤 */
function matchesKind(it: FeedItem, k: FeedKind | ''): boolean {
  if (k === 'unread') return !it.read
  if (k === 'starred') return it.starred
  if (k === 'later') return it.readLater
  return true
}
/** 列表筛选：上方分类（kind）与下方订阅源（sourceId）各自独立，同时命中才显示 */
const visibleItems = computed(() => allItems.value
  .filter((it) => {
    if (sourceId.value && it.sourceId !== sourceId.value) return false
    if (groupId.value) {
      const s = sources.value.find((x) => x.id === it.sourceId)
      if (!s || s.groupId !== groupId.value) return false
    }
    if (!matchesKind(it, kind.value)) return false
    return true
  })
  .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)))
const selectedItem = computed(() => allItems.value.find((i) => i.id === selectedId.value) ?? null)

/** 列表：顶部标题搜索 + 每页 20 条的无限滚动（数据仍一次性取全，只为渲染分页） */
const keyword = ref('')
const PAGE_SIZE = 20
const page = ref(1)
const matchedItems = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return visibleItems.value.filter((it) => !kw || (it.title || '').toLowerCase().includes(kw))
})
const pagedItems = computed(() => matchedItems.value.slice(0, page.value * PAGE_SIZE))
const hasMore = computed(() => pagedItems.value.length < matchedItems.value.length)
function loadMore(): void {
  if (hasMore.value) page.value += 1
}
/** 无限滚动：n-scrollbar 内部容器距底部 80px 时加载下一页 */
function onListScroll(e: Event): void {
  const el = e.target as HTMLElement | null
  if (!el || !el.scrollHeight) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMore()
}
watch(keyword, () => { page.value = 1 })
/** 切换分类/订阅源：页码回到第一页，并清空阅读器，避免右侧还停在上一个分类的文章 */
watch([sourceId, groupId, kind], () => {
  page.value = 1
  selectedId.value = ''
})

function sourceName(it: FeedItem): string {
  return it.sourceTitle || sources.value.find((s) => s.id === it.sourceId)?.title || '未知来源'
}
/** 订阅源图标：按源站常见路径依次尝试 favicon，全部失败回退首字头像，保证离线也有可辨识标记 */
const ICON_PATHS = ['/favicon.ico', '/apple-touch-icon.png']
const iconStep = ref<Record<string, number>>({})
function iconCandidates(s: FeedSource): string[] {
  try {
    const origin = new URL(s.url).origin
    return ICON_PATHS.map((p) => origin + p)
  } catch {
    return []
  }
}
function iconSrc(s: FeedSource): string {
  return iconCandidates(s)[iconStep.value[s.id] ?? 0] ?? ''
}
/** 当前候选加载失败时换下一个；候选耗尽后回退首字头像 */
function nextIcon(s: FeedSource): void {
  iconStep.value = { ...iconStep.value, [s.id]: (iconStep.value[s.id] ?? 0) + 1 }
}
function sourceInitial(s: FeedSource): string {
  const name = (s.title || s.url || '').trim()
  const ch = name.replace(/^https?:\/\//i, '').charAt(0)
  return ch ? ch.toUpperCase() : '·'
}
function fmtAgo(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前'
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
/** 阅读器正文：service 的 content 用空行分段 */
function paragraphs(it: FeedItem): string[] {
  const text = (it.content || it.summary || '').trim()
  return text ? text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) : []
}
function smartCount(k: FeedKind): number {
  if (k === 'all') return allItems.value.length
  if (k === 'unread') return unreadCount.value
  if (k === 'starred') return allItems.value.filter((i) => i.starred).length
  return allItems.value.filter((i) => i.readLater).length
}
/** 订阅源右侧数字：跟随上方选中的分类统计——选「未读」显示该源未读数，选「全部文章」显示总数 */
function countOfSource(id: string): number {
  return allItems.value.filter((i) => i.sourceId === id && matchesKind(i, kind.value)).length
}
function smartActive(k: FeedKind): boolean {
  return kind.value === k
}
/** 分类与订阅源可同时选中：这里只改分类，不动 sourceId */
function setSmart(k: FeedKind): void {
  kind.value = k
}
/** 再次点击已选中的分类即取消分类，订阅源选择保持不变 */
function toggleSmart(k: FeedKind): void {
  kind.value = smartActive(k) ? '' : k
}
function setSource(s: FeedSource): void {
  sourceId.value = s.id
}
/** 再次点击已选中的订阅源即取消订阅源，分类选择保持不变 */
function toggleSource(s: FeedSource): void {
  sourceId.value = sourceId.value === s.id ? '' : s.id
}
function setGroup(g: { id: string }): void {
  groupId.value = g.id
  sourceId.value = ''
}

/** 统一加载：全部数据经 IPC，调用失败由 call 的 fallback 兜底，异常统一记录 */
async function loadAll(): Promise<void> {
  busy.value = true
  try {
    const [g, s, all] = await Promise.all([
      call(() => feedBridge().groups(), FALLBACK_GROUPS),
      call(() => feedBridge().sources(), FALLBACK_SOURCES),
      call(() => feedBridge().items({ kind: 'all' }), FALLBACK_ITEMS)
    ])
    groups.value = g
    sources.value = s
    allItems.value = all
    // 进入页面 / 刷新后不自动展开文章：阅读器只在用户点击列表项后才出现。
    // 仅在当前选中的文章已不存在（比如被删源清理）时清空，避免右侧停在脏数据上。
    if (selectedId.value && !all.some((i) => i.id === selectedId.value)) selectedId.value = ''
  } catch (e) {
    log.exception('feed.loadAll', e)
  } finally {
    busy.value = false
  }
}

/** 打开文章即标记已读；乐观更新失败时回滚本地状态 */
async function openArticle(item: FeedItem): Promise<void> {
  selectedId.value = item.id
  if (item.read) return
  const prev = item.read
  item.read = true
  try {
    await call(() => feedBridge().markRead(item.id), true)
  } catch (e) {
    item.read = prev
    log.exception('feed.markRead', e)
    message.error('标记已读失败')
  }
}
async function toggleStar(item: FeedItem): Promise<void> {
  const prev = item.starred
  item.starred = !prev
  try {
    await call(() => feedBridge().toggleStar(item.id), !prev)
    message.success(prev ? '已取消收藏' : '已收藏')
  } catch (e) {
    item.starred = prev
    log.exception('feed.toggleStar', e)
    message.error('收藏操作失败')
  }
}
async function toggleLater(item: FeedItem): Promise<void> {
  const prev = item.readLater
  item.readLater = !prev
  try {
    await call(() => feedBridge().toggleLater(item.id), !prev)
    message.success(prev ? '已移出稍后读' : '已加入稍后读')
  } catch (e) {
    item.readLater = prev
    log.exception('feed.toggleLater', e)
    message.error('稍后读操作失败')
  }
}
async function refreshAll(): Promise<void> {
  busy.value = true
  try {
    const r = await call(() => feedBridge().refresh(plain({})), { added: 0, updated: 0, skipped: 0, failed: 0 })
    const parts = ['新增 ' + r.added, '更新 ' + r.updated]
    if (r.skipped) parts.push('未变更 ' + r.skipped)
    if (r.failed) parts.push('失败 ' + r.failed)
    const text = '已刷新：' + parts.join(' · ')
    if (r.failed && !r.added && !r.updated) message.warning(text)
    else message.success(text)
    await loadAll()
  } catch (e) {
    log.exception('feed.refresh', e)
    message.error('刷新失败')
  } finally {
    busy.value = false
  }
}

/** n-upload 自定义请求：读取 OPML 文本后交给 IPC 导入 */
async function onImportOpml(options: UploadCustomRequestOptions): Promise<void> {
  const file = options.file.file
  if (!file) { message.warning('未选择文件'); return }
  try {
    const text = await file.text()
    const r = await call(() => feedBridge().importOPML(plain({ text })), { imported: 0 })
    message.success('已导入 ' + (Number((r as { imported?: number }).imported) || 0) + ' 个订阅源')
    await loadAll()
  } catch (e) {
    log.exception('feed.importOPML', e)
    message.error('导入 OPML 失败')
  }
}
/** 导出 OPML：IPC 返回文本后由浏览器下载，不落磁盘到渲染进程 */
async function exportOpml(): Promise<void> {
  try {
    const text = await call(() => feedBridge().exportOPML(), '')
    if (!text) { message.warning('暂无订阅源可导出'); return }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/xml;charset=utf-8' }))
    a.download = 'feeds.opml'
    a.click()
    URL.revokeObjectURL(a.href)
    message.success('已导出 OPML')
  } catch (e) {
    log.exception('feed.exportOPML', e)
    message.error('导出失败')
  }
}
/** 打开原文：渲染层不能直接启动外部协议，统一走主进程 shell.openExternal。
 *  以管理员身份运行时系统可能拒绝唤起浏览器，这里给出可复制的链接而不是静默失败。 */
async function openOriginal(): Promise<void> {
  const url = selectedItem.value?.link
  if (!url) return
  try {
    await call(() => bridge().system.openExternal(plain({ url })), false)
  } catch (e) {
    log.exception('feed.openExternal', e)
    dialog.warning({
      title: '无法打开浏览器',
      content: '系统拒绝了打开默认浏览器的请求（常见于以管理员身份运行）。链接已保留，可复制后手动打开：' + url,
      positiveText: '复制链接',
      negativeText: '关闭',
      onPositiveClick: async () => {
        try {
          await navigator.clipboard.writeText(url)
          message.success('链接已复制')
        } catch {
          message.warning('复制失败，请手动选择链接复制')
        }
      }
    })
  }
}
/** 转待办默认落到「今日」：与待办页快速添加一致，取当天 23:59:59 */
function endOfToday(): number {
  const d = new Date()
  d.setHours(23, 59, 59, 0)
  return d.getTime()
}
/** 复用待办能力：把当前文章转为今日待办并保留来源链接 */
async function toTodo(): Promise<void> {
  const it = selectedItem.value
  if (!it) return
  try {
    await store.addTodo('阅读：《' + it.title + '》', {
      dueAt: endOfToday(),
      note: it.summary ?? null,
      sourceType: 'feed',
      sourceRef: it.link ?? it.id
    })
    message.success('已加入今日待办')
  } catch (e) {
    log.exception('feed.toTodo', e)
    message.error('转待办失败')
  }
}

onMounted(loadAll)
/** 侧栏「信息流」角标：未读数跨页面保持一致，这里同步给全局 store */
watch(unreadCount, (n) => store.setFeedUnread(n), { immediate: true })
</script>
<template>
  <Shell>
    <template #subtitle>{{ unreadCount }} 篇未读 · 共 {{ sources.length }} 个订阅源 · 最后抓取 {{ lastFetchText }}</template>
    <template #actions>
      <n-button size="small" :loading="busy" @click="refreshAll">刷新全部</n-button>
      <n-button size="small" type="primary" @click="goSettings">管理订阅</n-button>
      <n-button size="small" quaternary @click="exportOpml">导出 OPML</n-button>
      <n-upload :custom-request="onImportOpml" :show-file-list="false" :multiple="false">
        <n-button size="small" quaternary>导入 OPML</n-button>
      </n-upload>
    </template>

    <n-spin :show="busy">
      <div class="fd-layout">
        <aside class="card fd-side">
          <div class="fd-group">智能分类</div>
          <a v-for="nav in smartNav" :key="nav.kind" class="fd-nav" :class="{ on: smartActive(nav.kind) }" href="#" @click.prevent="toggleSmart(nav.kind)">
            <svg><use :href="'#' + nav.icon" /></svg><span class="fd-nav-label">{{ nav.label }}</span><span class="fd-nav-count">{{ smartCount(nav.kind) }}</span>
          </a>

          <template v-for="g in grouped" :key="g.id">
            <div class="fd-group">{{ g.name }}</div>
            <div v-for="s in g.sources" :key="s.id" class="fd-nav-row">
              <a class="fd-nav" :class="{ on: sourceId === s.id }" href="#" @click.prevent="toggleSource(s)">
                <span class="fd-nav-ico">
                  <img v-if="iconSrc(s)" :src="iconSrc(s)" alt="" @error="nextIcon(s)" />
                  <n-avatar v-else :size="16" round>{{ sourceInitial(s) }}</n-avatar>
                </span>
                <span class="fd-nav-label">{{ s.title || s.url }}</span><span class="fd-nav-count">{{ countOfSource(s.id) }}</span>
              </a>
            </div>
          </template>

          <div v-if="ungrouped.length" class="fd-group">未分组</div>
          <div v-for="s in ungrouped" :key="s.id" class="fd-nav-row">
            <a class="fd-nav" :class="{ on: sourceId === s.id }" href="#" @click.prevent="toggleSource(s)">
              <span class="fd-nav-ico">
                <img v-if="iconSrc(s)" :src="iconSrc(s)" alt="" @error="nextIcon(s)" />
                <n-avatar v-else :size="16" round>{{ sourceInitial(s) }}</n-avatar>
              </span>
              <span class="fd-nav-label">{{ s.title || s.url }}</span><span class="fd-nav-count">{{ countOfSource(s.id) }}</span>
            </a>
          </div>

          <div class="fd-side-foot">
            <n-button size="tiny" quaternary block @click="goSettings">+ 分组管理</n-button>
          </div>
        </aside>

        <section class="card fd-list">
          <div class="fd-search">
            <n-input v-model:value="keyword" size="small" clearable placeholder="搜索标题…">
              <template #prefix><svg class="fd-search-ico"><use href="#i-search" /></svg></template>
            </n-input>
          </div>
          <n-scrollbar class="fd-items" @scroll="onListScroll">
            <n-list v-if="pagedItems.length" hoverable clickable>
              <n-list-item v-for="item in pagedItems" :key="item.id" @click="openArticle(item)">
                <div class="fd-item">
                  <div class="fd-item-meta">
                    <n-tag v-if="!item.read" size="tiny" type="primary" round>未读</n-tag>
                    <span class="fd-item-source">{{ sourceName(item) }}</span>
                    <span class="fd-item-time">{{ fmtAgo(item.publishedAt) }}</span>
                  </div>
                  <n-text strong class="fd-item-title">{{ item.title }}</n-text>
                  <n-text depth="3" class="fd-item-sum">{{ item.summary }}</n-text>
                </div>
              </n-list-item>
            </n-list>
            <n-empty v-else class="fd-list-empty" size="small" :description="keyword ? '没有匹配的文章' : '这里还没有文章'" />
            <div v-if="hasMore" class="fd-more"><n-button size="tiny" quaternary @click="loadMore">加载更多</n-button></div>
            <div v-else-if="pagedItems.length" class="fd-more">已经到底了</div>
          </n-scrollbar>
        </section>

        <section class="card fd-reader">
          <div class="fd-tools">
            <n-button size="tiny" quaternary title="收起阅读器" @click="selectedId = ''">‹</n-button>
            <n-button-group size="tiny">
              <n-button quaternary @click="fontScale = Math.max(0.8, fontScale - 0.1)">A-</n-button>
              <n-button quaternary @click="fontScale = Math.min(1.6, fontScale + 0.1)">A+</n-button>
            </n-button-group>
            <n-button size="tiny" quaternary title="夜间模式" @click="darkArticle = !darkArticle">◐</n-button>
            <n-button v-if="selectedItem" size="tiny" quaternary :type="selectedItem.starred ? 'warning' : 'default'" title="收藏" @click="toggleStar(selectedItem)">★</n-button>
            <n-button v-if="selectedItem" size="tiny" quaternary :type="selectedItem.readLater ? 'primary' : 'default'" title="稍后读" @click="toggleLater(selectedItem)">◷</n-button>
            <span class="fd-tools-spacer"></span>
            <n-button size="tiny" quaternary @click="toTodo">转为待办</n-button>
          </div>
          <n-scrollbar class="fd-article" :class="{ 'fd-night': darkArticle }" :style="{ '--fd-reader-font': (13 * fontScale).toFixed(0) + 'px' }">
            <div class="fd-article-inner">
              <template v-if="selectedItem">
                <!-- 阅读器正文排版属产品独占视觉：段落结构来自服务 content，外观由主题/变量控制 -->
                <h2 class="fd-article-title">{{ selectedItem.title }}</h2>
                <div class="fd-byline"><n-text depth="3">{{ sourceName(selectedItem) }} · {{ selectedItem.author || '未知作者' }} · {{ fmtAgo(selectedItem.publishedAt) }}</n-text></div>
                <p v-for="(p, i) in paragraphs(selectedItem)" :key="i">{{ p }}</p>
                <n-blockquote v-if="selectedItem.summary">{{ selectedItem.summary }}</n-blockquote>
                <n-divider />
                <div class="fd-origin">
                  <n-text depth="3" class="fd-origin-link">原文链接：{{ selectedItem.link || '—' }}</n-text>
                  <n-button v-if="selectedItem.link" size="small" type="primary" @click="openOriginal">打开原文</n-button>
                </div>
              </template>
              <div v-else class="fd-reader-empty"><n-empty description="选择左侧文章开始阅读" /></div>
            </div>
          </n-scrollbar>
        </section>
      </div>
    </n-spin>




  </Shell>
</template>