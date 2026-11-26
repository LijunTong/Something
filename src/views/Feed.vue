<script setup lang="ts">
import { nextTick, ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  NButton, NCheckbox, NInput, NTag, NText,
  NBlockquote, NEmpty, NSpin, NUpload, NScrollbar, NAlert,
  NModal, NDrawer, NDrawerContent, NAvatar, useMessage, useDialog
} from 'naive-ui'
import type { UploadCustomRequestOptions } from 'naive-ui'
import Shell from '@/components/Shell.vue'
import FeedPanel from '@/components/settings/FeedPanel.vue'
import HtmlBodyFrame from '@/components/HtmlBodyFrame.vue'
import { call, bridge, plain } from '@/lib/ipc'
import { siteIconUrl, siteInitial } from '@/lib/siteIcon'
import { log } from '@/lib/logger'
import { useAppStore } from '@/stores/app'
import { useFocusQuery } from '@/composables/useFocusQuery'
import type { FeedApi, FeedGroupRow, FeedItem, FeedSource } from '@/types/api'
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
const groups = ref<FeedGroupRow[]>([])
const sources = ref<FeedSource[]>([])
const allItems = ref<FeedItem[]>([])
const kind = ref<FeedKind | ''>('unread')
const groupId = ref('')
/** 订阅筛选：点分类下的订阅行进入，再点一次取消；与分类筛选可叠加 */
const sourceId = ref('')
/** 列表多选：工具栏全选 / 批量已读 / 批量删除 */
const selectedIds = ref<string[]>([])
const selectedId = ref('')
/** 阅读器默认不显示：点开文章才从右侧滑出，列表因此能占满整行宽度 */
const showReader = ref(false)
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
type FeedDetail = {
  contentHtml: string | null
  content: string | null
  /** 正文是否为抓原文补全的全文；false 表示源只给了摘要 */
  fullText: boolean
  /** 最近一次抓原文的时间戳；null = 还没抓过 */
  fullFetchAt: number | null
}
const detailCache = ref<Record<string, FeedDetail>>({})
// 订阅源统一在「管理订阅」抽屉维护；分类（feed_group）在本页「分类管理」弹窗维护

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
/** 默认分类：可改名、不可删除；删别的分类时它承接订阅 */
const defaultCat = computed(() => groups.value.find((g) => g.isDefault) ?? null)
/** 订阅归哪个分类：没有分类的旧数据落到默认分类，避免侧栏看不到它的订阅 */
function groupOfSource(id: string): string | null {
  const s = sources.value.find((x) => x.id === id)
  return s ? (s.groupId ?? defaultCat.value?.id ?? null) : null
}
/** 分类右侧数字：跟随上方选中的智能分类统计（选「未读」时显示该分类下的未读数） */
function groupCount(id: string): number {
  return allItems.value.filter((i) => groupOfSource(i.sourceId) === id && matchesKind(i, kind.value)).length
}
/** 分类下的订阅：按名称排序，侧栏在分类行下方逐个列出 */
function sourcesOf(gid: string): FeedSource[] {
  return sources.value
    .filter((s) => groupOfSource(s.id) === gid)
    .sort((a, b) => String(a.title || a.url).localeCompare(String(b.title || b.url), 'zh-Hans-CN'))
}
/** 订阅右侧数字：口径与分类计数一致（跟随上方智能分类） */
function sourceCount(s: FeedSource): number {
  return allItems.value.filter((i) => i.sourceId === s.id && matchesKind(i, kind.value)).length
}
/** 分类口径：未读 / 收藏 / 稍后读；空值表示不过滤 */
function matchesKind(it: FeedItem, k: FeedKind | ''): boolean {
  if (k === 'unread') return !it.read
  if (k === 'starred') return it.starred
  if (k === 'later') return it.readLater
  return true
}
/** 列表筛选：智能分类（kind）+ 我的分类（groupId）+ 订阅（sourceId）同时命中才显示 */
const visibleItems = computed(() => allItems.value
  .filter((it) => {
    if (groupId.value && groupOfSource(it.sourceId) !== groupId.value) return false
    if (sourceId.value && it.sourceId !== sourceId.value) return false
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
/** 搜索框草稿：只有回车（或清空）才写入 keyword，避免输入过程中列表频繁跳动 */
const searchDraft = ref('')
function applySearch(): void {
  keyword.value = searchDraft.value.trim()
}
function clearSearch(): void {
  searchDraft.value = ''
  applySearch()
}
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
watch(keyword, (v) => {
  if (searchDraft.value !== v) searchDraft.value = v
  page.value = 1
})
/** 切换分类 / 订阅：页码回到第一页、收起阅读器、清空多选，避免停在上一个视图的文章上 */
watch([groupId, sourceId, kind], () => {
  page.value = 1
  showReader.value = false
  selectedIds.value = []
})
/** 抽屉关闭后清掉选中项，下次点开别的文章不会先闪一下上一篇 */
watch(showReader, (v) => { if (!v) selectedId.value = '' })

function sourceName(it: FeedItem): string {
  return it.sourceTitle || sources.value.find((s) => s.id === it.sourceId)?.title || '未知来源'
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
/** 智能分类与分类筛选是两个维度，可叠加（例如「未读」+「IT之家」） */
function smartActive(k: FeedKind): boolean {
  return kind.value === k
}
/** 再次点击已选中的智能分类即取消，分类/订阅选择保持不变 */
function toggleSmart(k: FeedKind): void {
  kind.value = smartActive(k) ? '' : k
}
/** 我的分类与订阅互斥单选：选分类时清掉订阅筛选 */
function toggleGroup(g: FeedGroupRow): void {
  groupId.value = groupId.value === g.id ? '' : g.id
  sourceId.value = ''
}
/** 点订阅行：只按该订阅筛选，同时清掉分类选择（两者互斥）；再点一次取消 */
function toggleSource(s: FeedSource): void {
  sourceId.value = sourceId.value === s.id ? '' : s.id
  groupId.value = ''
}

/** 统一加载：全部数据经 IPC，调用失败由 call 的 fallback 兜底，异常统一记录 */
async function loadAll(): Promise<void> {
  busy.value = true
  try {
    const [g, s, all] = await Promise.all([
      call(() => feedBridge().groups(), [] as FeedGroupRow[]),
      call(() => feedBridge().sources(), [] as FeedSource[]),
      call(() => feedBridge().items({ kind: 'all' }), [] as FeedItem[])
    ])
    groups.value = g
    sources.value = s
    allItems.value = all
    // 进入页面 / 刷新后不自动展开文章：阅读器只在用户点击列表项后才出现。
    // 仅在当前选中的文章已不存在（比如被删源清理）时清空，避免右侧停在脏数据上。
    if (selectedId.value && !all.some((i) => i.id === selectedId.value)) selectedId.value = ''
    // 分组/订阅被删后，残留的筛选条件退回「全部」，否则列表会空且侧栏无选中项
    if (groupId.value && !g.some((x) => x.id === groupId.value)) groupId.value = ''
    if (sourceId.value && !s.some((x) => x.id === sourceId.value)) sourceId.value = ''
    // 多选只保留仍存在的文章
    if (selectedIds.value.length) {
      const aliveSel = new Set(all.map((i) => i.id))
      selectedIds.value = selectedIds.value.filter((id) => aliveSel.has(id))
    }
    // 详情缓存只留仍存在的文章，避免删源后还挂着几十 KB 的孤儿 HTML
    const alive = new Set(all.map((i) => i.id))
    const keptIds = Object.keys(detailCache.value).filter((id) => alive.has(id))
    if (keptIds.length !== Object.keys(detailCache.value).length) {
      const next: Record<string, FeedDetail> = {}
      for (const id of keptIds) next[id] = detailCache.value[id]
      detailCache.value = next
    }
  } catch (e) {
    log.exception('feed.loadAll', e)
  } finally {
    busy.value = false
  }
}

/** 详情按需加载：正文 HTML 只在点开时取，避免列表把全库 HTML 拉进渲染进程。
 *  force=true 用于「重抓全文」：忽略缓存与主进程的失败冷却期，重新抓一次原文。 */
async function loadDetail(id: string, force = false): Promise<void> {
  if (!force && detailCache.value[id]) return
  htmlLoading.value = true
  try {
    const d = await call(() => feedBridge().detail(plain({ id, force })), null as FeedItem | null)
    if (d) {
      detailCache.value[id] = {
        contentHtml: d.contentHtml ?? null,
        content: d.content ?? null,
        fullText: !!d.fullText,
        fullFetchAt: d.fullFetchAt ?? null
      }
    }
  } catch (e) {
    log.exception('feed.detail', e)
  } finally {
    htmlLoading.value = false
  }
}

/** 重抓全文：少数派这类只给摘要的源，手动触发一次抓原网页 */
async function refetchFull(it: FeedItem): Promise<void> {
  if (!it.link) {
    message.warning('这篇文章没有原文链接')
    return
  }
  await loadDetail(it.id, true)
  const d = detailCache.value[it.id]
  if (d?.fullText) message.success('已补全全文')
  else message.warning('没能抓到全文，继续显示摘要')
}

/** 当前文章的正文来源状态：只在已取过详情、且没拿到全文时提示 */
const detailState = computed(() => {
  const it = selectedItem.value
  const d = it ? detailCache.value[it.id] : null
  return { onlySummary: !!d && !d.fullText }
})

/** 刷新后正文可能变了：清空详情缓存，并把正在读的那篇重新取一次 */
function resetDetails(): void {
  detailCache.value = {}
  if (selectedId.value) void loadDetail(selectedId.value)
}

/** 打开文章即标记已读；乐观更新失败时回滚本地状态 */
async function openArticle(item: FeedItem): Promise<void> {
  selectedId.value = item.id
  showReader.value = true
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

// —— 列表工具栏：全选 / 批量已读 / 批量删除（与邮件列表一致） ——
/** 全选范围 = 当前已渲染的列表项（置顶项 + 已加载分页），不是全库 */
const selectableIds = computed(() => [pinnedItem.value?.id, ...pagedItems.value.map((i) => i.id)].filter((x): x is string => !!x))
const checkedAll = computed(() => selectableIds.value.length > 0 && selectableIds.value.every((id) => selectedIds.value.includes(id)))
const checkedSome = computed(() => !checkedAll.value && selectableIds.value.some((id) => selectedIds.value.includes(id)))
function toggleRow(id: string, v: boolean): void {
  selectedIds.value = v ? [...new Set([...selectedIds.value, id])] : selectedIds.value.filter((x) => x !== id)
}
function toggleAll(v: boolean): void {
  selectedIds.value = v ? [...selectableIds.value] : []
}
/** 批量标记已读：先乐观更新，失败回滚 */
async function markSelectedRead(): Promise<void> {
  const ids = selectedIds.value.slice()
  if (!ids.length) return
  const hit = allItems.value.filter((i) => ids.includes(i.id) && !i.read)
  if (!hit.length) { message.info('选中的文章都已是已读'); return }
  hit.forEach((i) => { i.read = true })
  try {
    await call(() => feedBridge().markReadMany(plain({ ids })), ids.length)
    message.success('已标记 ' + hit.length + ' 篇为已读')
    selectedIds.value = []
  } catch (e) {
    hit.forEach((i) => { i.read = false })
    log.exception('feed.markReadMany', e)
    message.error('标记已读失败')
  }
}
/** 批量删除：二次确认后删文章本身，不影响订阅源；正在读的文章被删则关掉阅读器 */
function removeSelected(): void {
  const ids = selectedIds.value.slice()
  if (!ids.length) return
  dialog.warning({
    title: '删除文章',
    content: '确定删除选中的 ' + ids.length + ' 篇文章？删除后不可恢复。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const n = await call(() => feedBridge().removeItems(plain({ ids })), ids.length)
        const gone = new Set(ids)
        allItems.value = allItems.value.filter((i) => !gone.has(i.id))
        selectedIds.value = []
        if (gone.has(selectedId.value)) {
          selectedId.value = ''
          showReader.value = false
        }
        const next: typeof detailCache.value = {}
        for (const id of Object.keys(detailCache.value)) if (!gone.has(id)) next[id] = detailCache.value[id]
        detailCache.value = next
        message.success('已删除 ' + n + ' 篇文章')
      } catch (e) {
        log.exception('feed.removeItems', e)
        message.error('删除失败')
      }
    }
  })
}

// —— 分类管理：默认分类可改名不可删；删其它分类时订阅迁到默认分类 ——
const showCatManage = ref(false)
const newCatName = ref('')
const editingCatId = ref('')
const catDraftName = ref('')

function openCatManage(): void {
  showCatManage.value = true
  editingCatId.value = ''
  newCatName.value = ''
}
function startEditCat(g: FeedGroupRow): void {
  editingCatId.value = g.id
  catDraftName.value = g.name
}
function cancelEditCat(): void {
  editingCatId.value = ''
  catDraftName.value = ''
}
/** 服务端错误码转成可读文案：重复名、空名、默认分类不可删 */
function catError(e: unknown): string {
  const code = String((e as Error)?.message || '')
  if (code.includes('GROUP_NAME_REQUIRED')) return '请输入分类名称'
  if (code.includes('GROUP_NAME_EXISTS')) return '已有同名分类'
  if (code.includes('GROUP_IS_DEFAULT')) return '默认分类不能删除'
  return '操作失败'
}
async function saveCatName(g: FeedGroupRow): Promise<void> {
  const name = catDraftName.value.trim()
  if (!name) { message.warning('请输入分类名称'); return }
  if (name === g.name) { cancelEditCat(); return }
  try {
    const rows = await call(() => feedBridge().updateGroup(plain({ id: g.id, name })), null as FeedGroupRow[] | null)
    if (rows) groups.value = rows
    cancelEditCat()
    message.success('已重命名分类')
  } catch (e) {
    log.exception('feed.updateGroup', e)
    message.error(catError(e))
  }
}
async function addCat(): Promise<void> {
  const name = newCatName.value.trim()
  if (!name) { message.warning('请输入分类名称'); return }
  try {
    const rows = await call(() => feedBridge().addGroup(plain({ name })), null as FeedGroupRow[] | null)
    if (rows) groups.value = rows
    newCatName.value = ''
    message.success('已新增分类')
  } catch (e) {
    log.exception('feed.addGroup', e)
    message.error(catError(e))
  }
}
/** 删除分类前先告知影响面：多少订阅会被移到默认分类（订阅与文章都不会删） */
function confirmRemoveCat(g: FeedGroupRow): void {
  const affected = sources.value.filter((s) => s.groupId === g.id).length
  const dest = defaultCat.value
  const destName = dest ? dest.name : '默认分类'
  const content = affected > 0
    ? '「' + g.name + '」下有 ' + affected + ' 个订阅，删除分类后这些订阅会移到「' + destName + '」，订阅和文章都不会被删除。确定删除？'
    : '「' + g.name + '」下没有订阅，确定删除这个分类？'
  dialog.warning({
    title: '删除分类',
    content,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const r = await call(() => feedBridge().removeGroup(g.id), null as { groups: FeedGroupRow[]; count: number; defaultGroup: FeedGroupRow | null } | null)
        if (r) {
          groups.value = r.groups
          const destId = r.defaultGroup ? r.defaultGroup.id : ''
          // 订阅已迁到默认分类：先本地同步 groupId，再整体重载，避免侧栏和列表停留在旧分类下
          if (destId) sources.value = sources.value.map((s) => (s.groupId === g.id ? { ...s, groupId: destId } : s))
          // 当前正筛着被删分类时，视图落到默认分类，避免停在空列表上
          if (groupId.value === g.id) groupId.value = destId
        }
        await loadAll()
        message.success(affected > 0
          ? '已删除分类，' + affected + ' 个订阅已移到「' + destName + '」'
          : '已删除分类')
      } catch (e) {
        log.exception('feed.removeGroup', e)
        message.error(catError(e))
      }
    }
  })
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
      <n-button size="medium" type="primary" @click="openManagePanel">管理订阅</n-button>
      <n-button size="medium" quaternary @click="exportOpml">导出 OPML</n-button>
      <n-upload :custom-request="onImportOpml" :show-file-list="false" :multiple="false">
        <n-button size="medium" quaternary>导入 OPML</n-button>
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

          <!-- 我的分类：与待办页「我的清单」同构，管理入口在标题右侧；每个分类下挂该分类的订阅 -->
          <div class="fd-group fd-group-head">
            <span>我的分类</span>
            <n-button text size="tiny" @click="openCatManage">分类管理</n-button>
          </div>
          <n-scrollbar v-if="groups.length" class="fd-cats">
            <template v-for="g in groups" :key="g.id">
              <a class="fd-nav" :class="{ on: groupId === g.id }" href="#" @click.prevent="toggleGroup(g)">
                <span class="dotc" :style="{ background: g.color || 'var(--muted-2)' }"></span><span class="fd-nav-label">{{ g.name }}</span><span class="fd-nav-count">{{ groupCount(g.id) }}</span>
              </a>
              <a v-for="s in sourcesOf(g.id)" :key="s.id" class="fd-nav fd-nav-sub" :class="{ on: sourceId === s.id }" href="#" @click.prevent="toggleSource(s)">
                <!-- 订阅图标默认取源站 favicon，取不到时 NAvatar 回退到首字 -->
                <n-avatar class="fd-sub-icon" round :size="16" :src="siteIconUrl(s.url)">
                  <template #fallback>{{ siteInitial(s.title, s.url) }}</template>
                </n-avatar>
                <span class="fd-nav-label">{{ s.title || s.url }}</span><span class="fd-nav-count">{{ sourceCount(s) }}</span>
              </a>
            </template>
          </n-scrollbar>
          <div v-else class="fd-group">还没有分类，点「分类管理」新增</div>
        </aside>

        <section class="card fd-list">
          <!-- 列表工具栏：与邮件列表一致（全选 + 刷新 + 右对齐 标记已读 / 删除） -->
          <div class="fd-list-tools">
            <n-checkbox :checked="checkedAll" :indeterminate="checkedSome" @update:checked="toggleAll" />
            <n-button size="tiny" quaternary title="刷新" :loading="busy" :disabled="busy" @click="refreshAll">
              <template #icon><svg class="fd-ico" aria-hidden="true"><use href="#i-refresh" /></svg></template>
            </n-button>
            <span class="fd-tools-spacer"></span>
            <n-button size="tiny" quaternary title="标记已读" :disabled="!selectedIds.length" @click="markSelectedRead">
              <template #icon><svg class="fd-ico" aria-hidden="true"><use href="#i-ok" /></svg></template>
            </n-button>
            <n-button size="tiny" quaternary title="删除" :disabled="!selectedIds.length" @click="removeSelected">
              <template #icon><svg class="fd-ico" aria-hidden="true"><use href="#i-trash" /></svg></template>
            </n-button>
          </div>
          <div class="fd-search">
            <n-input
              v-model:value="searchDraft"
              size="small"
              clearable
              placeholder="搜索标题，回车确认"
              @keyup.enter="applySearch"
              @clear="clearSearch"
            >
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
                <div class="fd-row">
                  <span @click.stop>
                    <n-checkbox :checked="selectedIds.includes(pinnedItem?.id ?? '')" @update:checked="(v: boolean) => toggleRow(pinnedItem?.id ?? '', v)" />
                  </span>
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
                <div class="fd-row">
                  <span @click.stop>
                    <n-checkbox :checked="selectedIds.includes(item.id)" @update:checked="(v: boolean) => toggleRow(item.id, v)" />
                  </span>
                  <div class="fd-item" :data-item-id="item.id">
                    <div class="fd-item-meta">
                      <n-tag v-if="!item.read" size="tiny" type="primary" round>未读</n-tag>
                      <span class="fd-item-source">{{ sourceName(item) }}</span>
                      <span class="fd-item-time">{{ fmtAgo(item.publishedAt) }}</span>
                    </div>
                    <n-text strong class="fd-item-title">{{ item.title }}</n-text>
                    <n-text depth="3" class="fd-item-sum">{{ item.summary }}</n-text>
                  </div>
                </div>
              </n-list-item>
            </n-list>
            <n-empty v-else class="fd-list-empty" size="small" :description="keyword ? '没有匹配的文章' : '这里还没有文章'">
              <template #extra>
                <div class="fd-empty-actions">
                  <n-button v-if="keyword" size="small" @click="clearSearch">清除搜索</n-button>
                  <template v-else>
                    <n-button size="small" :loading="busy" :disabled="busy" @click="refreshAll">刷新</n-button>
                    <n-button size="small" type="primary" @click="openManagePanel">管理订阅</n-button>
                  </template>
                </div>
              </template>
            </n-empty>
            <div v-if="hasMore" class="fd-more"><n-button size="tiny" quaternary @click="loadMore">加载更多</n-button></div>
            <div v-else-if="pagedItems.length || pinnedItem" class="fd-more">已经到底了</div>
          </n-scrollbar>
        </section>

      </div>
    </n-spin>




    <!-- 阅读器：默认不显示，点文章后从右侧滑出，列表因此可用满整行宽度；
         正文排版属产品独占视觉，HTML 由 HtmlBodyFrame 的沙箱 iframe 承载，纯文本走段落样式 -->
    <n-drawer v-model:show="showReader" :width="640" placement="right">
      <n-drawer-content :native-scrollbar="false" closable>
        <template #header>{{ selectedItem ? selectedItem.title : '阅读' }}</template>
        <div class="fd-reader-body">
          <div class="fd-tools">
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
            <n-button v-if="selectedItem && selectedItem.link" size="tiny" quaternary :loading="htmlLoading" title="重新抓取原文全文" @click="refetchFull(selectedItem)">补全全文</n-button>
            <n-button v-if="selectedItem" size="tiny" quaternary :type="selectedItem.starred ? 'warning' : 'default'" title="收藏" @click="toggleStar(selectedItem)">★</n-button>
            <n-button v-if="selectedItem" size="tiny" quaternary :type="selectedItem.readLater ? 'primary' : 'default'" title="稍后读" @click="toggleLater(selectedItem)">◷</n-button>
            <span class="fd-tools-spacer"></span>
            <n-button size="tiny" quaternary @click="toTodo">转为待办</n-button>
          </div>
          <n-scrollbar class="fd-article" :class="{ 'fd-night': darkArticle }" :style="{ '--fd-reader-font': (13 * fontScale).toFixed(0) + 'px' }">
            <div class="fd-article-inner">
              <template v-if="selectedItem">
                <div class="fd-byline"><n-text depth="3">{{ sourceName(selectedItem) }} · {{ selectedItem.author || '未知作者' }} · {{ fmtAgo(selectedItem.publishedAt) }}</n-text></div>
                <!-- 源只给摘要时的说明：阅读器不能让人误以为整篇就这么长 -->
                <n-alert v-if="detailState.onlySummary && !htmlLoading" type="info" :bordered="false" size="small" class="fd-fulltext-tip">
                  该源只提供摘要，未能获取原文全文。可点上方「补全全文」重试，或「打开原文」查看。
                </n-alert>
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
              <div v-else class="fd-reader-empty"><n-empty description="选择文章开始阅读" /></div>
            </div>
          </n-scrollbar>
        </div>
      </n-drawer-content>
    </n-drawer>

    <!-- 分类管理：改名 / 新增 / 删除；默认分类只能改名，删除时订阅迁到默认分类 -->
    <n-modal v-model:show="showCatManage" preset="card" title="分类管理" style="width:420px">
      <div class="lm-rows">
        <div v-for="g in groups" :key="g.id" class="lm-row">
          <template v-if="editingCatId === g.id">
            <n-input v-model:value="catDraftName" size="small" placeholder="分类名称" @keyup.enter="saveCatName(g)" />
            <div class="lm-row-actions">
              <n-button size="tiny" type="primary" @click="saveCatName(g)">保存</n-button>
              <n-button size="tiny" @click="cancelEditCat">取消</n-button>
            </div>
          </template>
          <template v-else>
            <span class="dotc" :style="{ background: g.color || 'var(--muted-2)' }"></span>
            <span class="lm-name">{{ g.name }}</span>
            <n-tag v-if="g.isDefault" size="tiny" round>默认</n-tag>
            <div class="lm-row-actions">
              <n-button text size="tiny" @click="startEditCat(g)">改名</n-button>
              <n-button v-if="!g.isDefault" text size="tiny" @click="confirmRemoveCat(g)">删除</n-button>
            </div>
          </template>
        </div>
      </div>
      <div class="lm-add">
        <n-input v-model:value="newCatName" size="small" placeholder="新分类名称，回车新增" @keyup.enter="addCat" />
        <n-button size="small" type="primary" :disabled="!newCatName.trim()" @click="addCat">新增分类</n-button>
      </div>
    </n-modal>

    <!-- 订阅源抽屉：新增/修改/分组/OPML 都在这里，不再跳设置页 -->
    <n-drawer v-model:show="showFeedPanel" :width="720" placement="right">
      <n-drawer-content title="订阅源" closable :native-scrollbar="false">
        <FeedPanel embedded @changed="loadAll" />
      </n-drawer-content>
    </n-drawer>
  </Shell>
</template>