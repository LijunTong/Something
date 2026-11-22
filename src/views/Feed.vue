<script setup lang="ts">
import { nextTick, ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  NButton, NInput, NTag, NText,
  NBlockquote, NEmpty, NSpin, NUpload, NAvatar, NScrollbar, NTooltip, NAlert,
  useMessage, useDialog
} from 'naive-ui'
import type { UploadCustomRequestOptions } from 'naive-ui'
import Shell from '@/components/Shell.vue'
import FeedPanel from '@/components/settings/FeedPanel.vue'
import HtmlBodyFrame from '@/components/HtmlBodyFrame.vue'
import { call, bridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useAppStore } from '@/stores/app'
import { useFocusQuery } from '@/composables/useFocusQuery'
import type { FeedApi, FeedItem, FeedSource } from '@/types/api'
import '@/styles/feed.css'

type FeedKind = 'unread' | 'all' | 'starred' | 'later'

const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
/** 订阅源管理收敛到本页抽屉：与设置页共用同一个面板组件 */
const showFeedPanel = ref(false)
function openManagePanel() { showFeedPanel.value = true }

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
const route = useRoute()
// 深链定位：仪表盘点某篇文章 → /feed?focus=<id>（兼容旧 ?item=<id>）
const {
  focusId: focusKey,
  hint: hint,
  highlight: highlightId,
  locate: locateFocus,
  miss: missFocus,
  dismiss: dismissHint
} = useFocusQuery()
const busy = ref(false)
const fontScale = ref(1)
const darkArticle = ref(false)
/** 阅读器视图：HTML 版优先，只有详情里没有 HTML 时才落回纯文本 */
const showHtml = ref(true)
const showRemoteImages = ref(false)
const htmlLoading = ref(false)
/** 详情缓存：列表接口不返回 content_html（正文太大），点开文章时按需取 */
const detailCache = ref<Record<string, { contentHtml: string | null; content: string | null }>>({})
/** 单源刷新中：只让被点的那个源转圈，不整页 spin */
const refreshingId = ref('')
// 订阅源与分组的增删改统一在「设置 › 订阅源」维护，本页只负责阅读

/** 无 IPC 时的浏览器降级数据：字段名与 FeedItem / FeedSource 契约一致 */
// 无 IPC 时的浏览器降级：一律返回空数组，不再内置示例订阅与文章
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
/** 当前文章的 HTML 正文：详情优先；没有 HTML 时返回 null，模板自动走纯文本 */
const selectedHtml = computed(() => {
  const it = selectedItem.value
  if (!it) return null
  return detailCache.value[it.id]?.contentHtml ?? it.contentHtml ?? null
})

/** 列表：顶部标题搜索 + 每页 20 条的无限滚动（数据仍一次性取全，只为渲染分页） */
const keyword = ref('')
const PAGE_SIZE = 20
const page = ref(1)
const matchedItems = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return visibleItems.value.filter((it) => !kw || (it.title || '').toLowerCase().includes(kw))
})
/** 深链定位的目标文章：单独置顶成一行。未读文章往往比已读的旧，在全量倒序列表里排得很后，
    靠「展开分页再滚动」会让用户觉得莫名其妙跳到后面去了，所以直接钉在列表最上面。 */
const pinnedItem = computed(() => {
  const key = focusKeyOfQuery()
  if (!key) return null
  return allItems.value.find((i) => i.id === key) ?? null
})
/** 列表主体：把置顶那条从正常序列里摘掉，避免出现两次 */
const listItems = computed(() => {
  const pinId = pinnedItem.value ? pinnedItem.value.id : ''
  return pinId ? matchedItems.value.filter((i) => i.id !== pinId) : matchedItems.value
})
const pagedItems = computed(() => listItems.value.slice(0, page.value * PAGE_SIZE))
const hasMore = computed(() => pagedItems.value.length < listItems.value.length)
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
/** 长段落按句末切块：源只给一整段纯文本时（如 IT之家 RSS），整篇挤成一片读不下去 */
function splitLongParagraph(text: string): string[] {
  if (text.length <= 220) return [text]
  const out: string[] = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (buf.length >= 180 && /[。！？；!?;\n]/.test(ch)) {
      out.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** 阅读器正文：详情里的纯文本优先，列表项自带 content 兜底；service 用空行分段 */
function paragraphs(it: FeedItem): string[] {
  const text = (detailCache.value[it.id]?.content || it.content || it.summary || '').trim()
  if (!text) return []
  const blocks = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  return blocks.length > 1 ? blocks : splitLongParagraph(text)
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
      call(() => feedBridge().groups(), [] as Array<{ id: string; name: string }>),
      call(() => feedBridge().sources(), [] as FeedSource[]),
      call(() => feedBridge().items({ kind: 'all' }), [] as FeedItem[])
    ])
    groups.value = g
    sources.value = s
    allItems.value = all
    // 进入页面 / 刷新后不自动展开文章：阅读器只在用户点击列表项后才出现。
    // 仅在当前选中的文章已不存在（比如被删源清理）时清空，避免右侧停在脏数据上。
    if (selectedId.value && !all.some((i) => i.id === selectedId.value)) selectedId.value = ''
    // 详情缓存只留仍存在的文章，避免删源后还挂着几十 KB 的孤儿 HTML
    const alive = new Set(all.map((i) => i.id))
    const keptIds = Object.keys(detailCache.value).filter((id) => alive.has(id))
    if (keptIds.length !== Object.keys(detailCache.value).length) {
      const next: Record<string, { contentHtml: string | null; content: string | null }> = {}
      for (const id of keptIds) next[id] = detailCache.value[id]
      detailCache.value = next
    }
  } catch (e) {
    log.exception('feed.loadAll', e)
  } finally {
    busy.value = false
  }
}

/** 详情按需加载：正文 HTML 只在点开时取，避免列表把全库 HTML 拉进渲染进程 */
async function loadDetail(id: string): Promise<void> {
  if (detailCache.value[id]) return
  htmlLoading.value = true
  try {
    const d = await call(() => feedBridge().detail(plain({ id })), null as FeedItem | null)
    if (d) detailCache.value[id] = { contentHtml: d.contentHtml ?? null, content: d.content ?? null }
  } catch (e) {
    log.exception('feed.detail', e)
  } finally {
    htmlLoading.value = false
  }
}

/** 刷新后正文可能变了：清空详情缓存，并把正在读的那篇重新取一次 */
function resetDetails(): void {
  detailCache.value = {}
  if (selectedId.value) void loadDetail(selectedId.value)
}

/** 打开文章即标记已读；乐观更新失败时回滚本地状态 */
async function openArticle(item: FeedItem): Promise<void> {
  selectedId.value = item.id
  // 每篇文章的远程图片单独授权，切换即复位（与邮件阅读器一致）
  showRemoteImages.value = false
  void loadDetail(item.id)
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
type RefreshResult = { added: number; updated: number; skipped: number; failed: number }
/** 刷新结果提示：全部刷新与单源刷新共用一套文案 */
function refreshSummary(r: RefreshResult, label: string): void {
  const parts = ['新增 ' + r.added, '更新 ' + r.updated]
  if (r.skipped) parts.push('未变更 ' + r.skipped)
  if (r.failed) parts.push('失败 ' + r.failed)
  const text = label + '：' + parts.join(' · ')
  if (r.failed && !r.added && !r.updated) message.warning(text)
  else message.success(text)
}

async function refreshAll(): Promise<void> {
  busy.value = true
  try {
    const r = await call(() => feedBridge().refresh(plain({})), { added: 0, updated: 0, skipped: 0, failed: 0 })
    refreshSummary(r, '已刷新')
    resetDetails()
    await loadAll()
  } catch (e) {
    log.exception('feed.refresh', e)
    message.error('刷新失败')
  } finally {
    busy.value = false
  }
}

/** 单源刷新：只抓这一个源，成功后顺带刷新该源的「最后抓取」 */
async function refreshSource(s: FeedSource): Promise<void> {
  if (refreshingId.value || busy.value) return
  refreshingId.value = s.id
  try {
    const r = await call(() => feedBridge().refresh(plain({ sourceId: s.id })), { added: 0, updated: 0, skipped: 0, failed: 0 })
    refreshSummary(r, (s.title || s.url) + ' 刷新完成')
    resetDetails()
    await loadAll()
  } catch (e) {
    log.exception('feed.refreshSource', e)
    message.error('刷新失败：' + (s.title || s.url))
  } finally {
    refreshingId.value = ''
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

/** 深链目标：统一用 ?focus=<id>，同时兼容搜索页与旧链接的 ?item=<id> */
function focusKeyOfQuery(): string {
  return String(route.query.focus || route.query.item || '')
}

/** 仪表盘/搜索直达：切到全部文章、筛出这一篇并打开阅读器，再把列表滚到该条 */
async function openFromQuery(id: string): Promise<void> {
  if (!id) return
  if (!allItems.value.some((i) => i.id === id)) await loadAll()
  const item = allItems.value.find((i) => i.id === id)
  if (!item) { missFocus(); return }
  // 目标可能是已读的：分类固定到「全部文章」，并清掉订阅源/分组/关键词，
  // 保证它一定在当前列表里，而不是落在「未读」筛选下看不见。
  sourceId.value = ''
  groupId.value = ''
  keyword.value = ''
  kind.value = 'all'
  // 目标由模板里的 pinnedItem 置顶渲染，这里只等列表重排完再定位
  await nextTick()
  await openArticle(item)
  await nextTick()
  await locateFocus(id, '来自仪表盘：' + (item.title || '（无标题）'))
}

onMounted(async () => {
  await loadAll()
  await openFromQuery(focusKeyOfQuery())
})

// 在同一页面再次从搜索打开另一篇时也要生效（路由 query 变化但组件复用）
watch(() => [route.query.focus, route.query.item], () => {
  const key = focusKeyOfQuery()
  if (key) void openFromQuery(key)
})
/** 侧栏「信息流」角标：未读数跨页面保持一致，这里同步给全局 store */
watch(unreadCount, (n) => store.setFeedUnread(n), { immediate: true })
</script>
<template>
  <Shell>
    <template #subtitle>{{ unreadCount }} 篇未读 · 共 {{ sources.length }} 个订阅源 · 最后抓取 {{ lastFetchText }}</template>
    <template #actions>
      <n-button size="small" :loading="busy" @click="refreshAll">刷新全部</n-button>
      <n-button size="small" type="primary" @click="openManagePanel">管理订阅</n-button>
      <n-button size="small" quaternary @click="exportOpml">导出 OPML</n-button>
      <n-upload :custom-request="onImportOpml" :show-file-list="false" :multiple="false">
        <n-button size="small" quaternary>导入 OPML</n-button>
      </n-upload>
    </template>

    <n-spin :show="busy">
      <n-alert v-if="hint" :type="hint.type" closable :bordered="false" class="focus-hint" @close="dismissHint">
      <div class="focus-hint-row">
        <span>{{ hint.text }}</span>
        <n-button text size="tiny" @click="dismissHint">清除定位</n-button>
      </div>
    </n-alert>

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
              <n-tooltip trigger="hover" placement="right">
                <template #trigger>
                  <n-button class="fd-refresh" size="tiny" quaternary :loading="refreshingId === s.id" :disabled="busy" title="获取最新文章" @click.stop="refreshSource(s)">↻</n-button>
                </template>
                只抓取「{{ s.title || s.url }}」的最新文章
              </n-tooltip>
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
            <n-tooltip trigger="hover" placement="right">
              <template #trigger>
                <n-button class="fd-refresh" size="tiny" quaternary :loading="refreshingId === s.id" :disabled="busy" title="获取最新文章" @click.stop="refreshSource(s)">↻</n-button>
              </template>
              只抓取「{{ s.title || s.url }}」的最新文章
            </n-tooltip>
          </div>

          <div class="fd-side-foot">
            <n-button size="tiny" quaternary block @click="openManagePanel">+ 分组管理</n-button>
          </div>
        </aside>

        <section class="card fd-list">
          <div class="fd-search">
            <n-input v-model:value="keyword" size="small" clearable placeholder="搜索标题…">
              <template #prefix><svg class="fd-search-ico"><use href="#i-search" /></svg></template>
            </n-input>
          </div>
          <n-scrollbar class="fd-items" @scroll="onListScroll">
            <n-list v-if="pagedItems.length || pinnedItem" hoverable clickable>
              <!-- 深链定位目标：置顶一条，一眼可见，不用在全量倒序列表里翻页找 -->
              <n-list-item
                v-if="pinnedItem"
                :key="'pin-' + pinnedItem.id"
                :class="{ 'fd-row-active': selectedId === pinnedItem.id, 'focus-flash': highlightId === pinnedItem.id }"
                :data-focus-id="pinnedItem.id"
                :style="selectedId === pinnedItem.id && highlightId !== pinnedItem.id ? { background: 'var(--primary-softer)' } : undefined"
                @click="openArticle(pinnedItem)"
              >
                <div class="fd-item">
                  <div class="fd-item-meta">
                    <n-tag size="tiny" round>来自仪表盘</n-tag>
                    <n-tag v-if="!pinnedItem.read" size="tiny" type="primary" round>未读</n-tag>
                    <span class="fd-item-source">{{ sourceName(pinnedItem) }}</span>
                    <span class="fd-item-time">{{ fmtAgo(pinnedItem.publishedAt) }}</span>
                  </div>
                  <n-text strong class="fd-item-title">{{ pinnedItem.title }}</n-text>
                  <n-text depth="3" class="fd-item-sum">{{ pinnedItem.summary }}</n-text>
                </div>
              </n-list-item>
              <n-list-item
            v-for="item in pagedItems"
            :key="item.id"
            :class="{ 'fd-row-active': selectedId === item.id, 'focus-flash': highlightId === item.id }"
            :data-focus-id="item.id"
            :style="selectedId === item.id && highlightId !== item.id ? { background: 'var(--primary-softer)' } : undefined"
            :aria-selected="selectedId === item.id"
            @click="openArticle(item)"
          >
                <div class="fd-item" :data-item-id="item.id">
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
            <div v-else-if="pagedItems.length || pinnedItem" class="fd-more">已经到底了</div>
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
            <n-button v-if="selectedHtml" size="tiny" quaternary :type="showHtml ? 'primary' : 'default'" title="切换正文格式" @click="showHtml = !showHtml">
              {{ showHtml ? 'HTML' : '纯文本' }}
            </n-button>
            <n-button v-if="showHtml && selectedHtml" size="tiny" quaternary :type="showRemoteImages ? 'primary' : 'default'" title="远程图片默认拦截" @click="showRemoteImages = !showRemoteImages">
              {{ showRemoteImages ? '隐藏图片' : '显示图片' }}
            </n-button>
            <n-button v-if="selectedItem" size="tiny" quaternary :type="selectedItem.starred ? 'warning' : 'default'" title="收藏" @click="toggleStar(selectedItem)">★</n-button>
            <n-button v-if="selectedItem" size="tiny" quaternary :type="selectedItem.readLater ? 'primary' : 'default'" title="稍后读" @click="toggleLater(selectedItem)">◷</n-button>
            <span class="fd-tools-spacer"></span>
            <n-button size="tiny" quaternary @click="toTodo">转为待办</n-button>
          </div>
          <n-scrollbar class="fd-article" :class="{ 'fd-night': darkArticle }" :style="{ '--fd-reader-font': (13 * fontScale).toFixed(0) + 'px' }">
            <div class="fd-article-inner">
              <template v-if="selectedItem">
                <!-- 阅读器正文排版属产品独占视觉：HTML 由 HtmlBodyFrame 的沙箱 iframe 承载，纯文本走段落样式 -->
                <h2 class="fd-article-title">{{ selectedItem.title }}</h2>
                <div class="fd-byline"><n-text depth="3">{{ sourceName(selectedItem) }} · {{ selectedItem.author || '未知作者' }} · {{ fmtAgo(selectedItem.publishedAt) }}</n-text></div>
                <HtmlBodyFrame
                  v-if="showHtml && selectedHtml"
                  :html="selectedHtml"
                  :allow-remote-images="showRemoteImages"
                  :font-size="(13 * fontScale).toFixed(0) + 'px'"
                  :night="darkArticle"
                  title="文章正文"
                />
                <n-spin v-else-if="showHtml && htmlLoading" size="small" />
                <p v-for="(p, i) in paragraphs(selectedItem)" v-else :key="i">{{ p }}</p>
                <n-blockquote v-if="selectedItem.summary && !(showHtml && selectedHtml)">{{ selectedItem.summary }}</n-blockquote>
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




    <!-- 订阅源抽屉：新增/修改/分组/OPML 都在这里，不再跳设置页 -->
    <n-drawer v-model:show="showFeedPanel" :width="720" placement="right">
      <n-drawer-content title="订阅源" closable :native-scrollbar="false">
        <FeedPanel embedded @changed="loadAll" />
      </n-drawer-content>
    </n-drawer>
  </Shell>
</template>