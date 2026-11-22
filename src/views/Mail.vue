<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton, NCheckbox, NInput, NSelect, NTag, NText, NAvatar, NEmpty, NSpin, NScrollbar,
  NModal, NForm, NFormItem, NInputNumber, NDrawer, NDrawerContent, NCard, NAlert,
  useMessage, useDialog
} from 'naive-ui'
import Shell from '@/components/Shell.vue'
import HtmlBodyFrame from '@/components/HtmlBodyFrame.vue'
import MailAccountsPanel from '@/components/settings/MailAccountsPanel.vue'
import { call, bridge, plain } from '@/lib/ipc'
import type { IpcEnvelope } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { webmailUrl } from '@/lib/webmail'
import { useAppStore } from '@/stores/app'
import { useSettings } from '@/composables/useSettings'
import { useFocusQuery } from '@/composables/useFocusQuery'
import type { MailAccount, MailApi, MailFolder, MailRow } from '@/types/api'
import '@/styles/side-nav.css'
import '@/styles/mail.css'

type FolderPick = { accountId?: string; folderId?: string; kind: string; label: string }
type RuleRow = {
  id?: string; name?: string; priority?: number; enabled?: boolean
  conditions?: unknown; actions?: unknown
}
type RuleForm = {
  id: string; name: string; priority: number; enabled: boolean
  field: string; op: string; value: string; actionType: string; actionValue: string
}

/** 本地适配：Api 顶层未直接暴露 mail 字段时用 unknown 桥接，不使用宽松 any。 */
function mailApi(): MailApi { return (bridge() as unknown as { mail: MailApi }).mail }

const message = useMessage()
const dialog = useDialog()
const store = useAppStore()
const settings = useSettings()

const accounts = ref<MailAccount[]>([])
const folders = ref<MailFolder[]>([])
const mails = ref<MailRow[]>([])
const selected = ref<MailRow | null>(null)
const active = ref<FolderPick>({ label: '统一收件箱', kind: 'inbox' })
const search = ref('')
const loading = ref(false)
const selectedIds = ref<string[]>([])
const checkedAll = ref(false)
const showRemoteImages = ref(false)
const showHtml = ref(true)
// 深链定位：仪表盘点某封邮件 → /mail?focus=<id>，落地后打开阅读器并把列表行滚到中间
const {
  focusId: focusKey,
  hint: hint,
  highlight: highlightId,
  locate: locateFocus,
  miss: missFocus,
  dismiss: dismissHint
} = useFocusQuery()

const showRules = ref(false)
const rules = ref<RuleRow[]>([])
const showRuleModal = ref(false)
const ruleForm = ref<RuleForm>({ id: '', name: '', priority: 0, enabled: true, field: 'from', op: 'contains', value: '', actionType: 'label', actionValue: '' })

const fieldOptions = [
  { label: '发件人', value: 'from' },
  { label: '主题', value: 'subject' },
  { label: '正文', value: 'body' }
]
const opOptions = [
  { label: '包含', value: 'contains' },
  { label: '等于', value: 'equals' }
]
const actionOptions = [
  { label: '加标签', value: 'label' },
  { label: '标记重要', value: 'important' },
  { label: '静默', value: 'silent' }
]

/** 停用账户在邮件页完全不出现：左栏、文件夹加载、未读统计、邮件列表都只认这份清单 */
const enabledAccounts = computed(() => accounts.value.filter((a) => a.enabled))
const unreadTotal = computed(() =>
  folders.value.filter((f) => f.kind === 'inbox').reduce((sum, f) => sum + Number(f.unreadCount || 0), 0)
)
const lastSync = computed(() => {
  const list = Array.isArray(accounts.value) ? accounts.value : []
  const ts = list.reduce((max, a) => Math.max(max, Number(a.lastSyncAt || 0)), 0)
  if (!ts) return '尚未同步'
  const d = new Date(ts)
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
})
/**
 * 自动同步频率：读设置里的 mail.autoSyncMin，主进程按同一个值定时拉取。
 * 0 表示关闭自动同步，只能手动点「同步」。
 */
const autoSyncMin = ref(15)
const autoSyncOptions = [
  { label: '关闭自动同步', value: 0 },
  { label: '每 5 分钟自动同步', value: 5 },
  { label: '每 15 分钟自动同步', value: 15 },
  { label: '每 30 分钟自动同步', value: 30 },
  { label: '每 60 分钟自动同步', value: 60 }
]
const autoSyncLabel = computed(() => (autoSyncMin.value ? '每 ' + autoSyncMin.value + ' 分钟自动同步' : '自动同步已关闭'))
const subtitle = computed(() =>
  enabledAccounts.value.length
    ? '未读 ' + unreadTotal.value + ' · 共 ' + enabledAccounts.value.length + ' 个账户 · 最后同步 ' + lastSync.value + ' · ' + autoSyncLabel.value
    : '未启用邮箱账户 · 到「账户管理」开启'
)

function fmtUnknown(v: unknown): string {
  if (Array.isArray(v)) return v.map(fmtUnknown).filter(Boolean).join('、')
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).map((x) => String(x)).join(' ')
  return v == null ? '' : String(v)
}
function fmtTime(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
  return (d.getMonth() + 1) + '/' + d.getDate()
}
function fmtSize(size: number | null | undefined): string {
  if (!size || size <= 0) return '未知大小'
  return size >= 1024 * 1024 ? (size / 1024 / 1024).toFixed(1) + ' MB' : Math.round(size / 1024) + ' KB'
}
function normalizeAccounts(rows: MailAccount[] | unknown): MailAccount[] {
  return Array.isArray(rows) ? (rows as MailAccount[]) : []
}
function labelsOf(row: MailRow): string[] {
  const raw: unknown = row.labels
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
    } catch { return raw ? [raw] : [] }
  }
  return []
}
async function loadAccounts() {
  try {
    accounts.value = normalizeAccounts(await call(() => mailApi().accounts(), [] as MailAccount[]))
    ensureActive()
  } catch (e) { log.exception('mail.accounts', e) }
}
/** 当前选中的账户被停用（或删除）时，回到统一收件箱，避免右栏留着不可见账户的正文 */
function ensureActive() {
  const id = active.value.accountId
  if (!id) return
  if (enabledAccounts.value.some((a) => a.id === id)) return
  active.value = { kind: 'inbox', label: '统一收件箱' }
  selected.value = null
  void loadMails()
}
async function loadFolders() {
  try {
    const all: MailFolder[] = []
    for (const a of enabledAccounts.value) {
      const rows = await call(() => mailApi().folders(plain(a.id)), [] as MailFolder[])
      all.push(...rows)
    }
    folders.value = all
  } catch (e) { log.exception('mail.folders', e) }
}
async function loadMails() {
  loading.value = true
  try {
    const f = active.value
    const filter = { accountId: f.accountId, folderId: f.folderId, kind: f.kind, search: search.value.trim() || undefined }
    mails.value = await call(() => mailApi().list(plain(filter)), [] as MailRow[])
    selectedIds.value = []
    checkedAll.value = false
    if (selected.value && !mails.value.some((m) => m.id === selected.value?.id)) selected.value = null
  } catch (e) {
    log.exception('mail.list', e)
  } finally {
    loading.value = false
  }
}

function pick(f: FolderPick) {
  active.value = f
  selected.value = null
  void loadMails()
}
function pickFolder(folder: MailFolder) {
  pick({ accountId: folder.accountId, folderId: folder.id, kind: folder.kind, label: folder.name })
}
function pickFolderByKind(accountId: string, kind: string) {
  const f = folders.value.find((x) => x.accountId === accountId && x.kind === kind)
  if (f) pickFolder(f)
  else pick({ accountId, kind, label: '收件箱' })
}
function foldersOf(accountId: string): MailFolder[] {
  return folders.value.filter((f) => f.accountId === accountId)
}
function unreadOf(accountId: string): number {
  return folders.value
    .filter((f) => f.accountId === accountId && f.kind === 'inbox')
    .reduce((sum, f) => sum + Number(f.unreadCount || 0), 0)
}

async function syncAll() {
  if (!accounts.value.length) { message.warning('请先在设置中添加邮箱账户'); return }
  loading.value = true
  let added = 0
  let updated = 0
  try {
    for (const a of accounts.value.filter((x) => x.enabled)) {
      const r = await call(() => mailApi().sync(plain({ accountId: a.id })), { ok: false, accountId: a.id, added: 0, updated: 0, total: 0 })
      added += Number(r?.added || 0)
      updated += Number(r?.updated || 0)
    }
    await loadFolders()
    await loadMails()
    message.success('同步完成，新增 ' + added + ' 封 · 更新 ' + updated + ' 封')
  } catch (e) {
    log.exception('mail.sync', e)
    message.error('同步失败：' + (e instanceof Error ? e.message : String(e)))
  } finally {
    loading.value = false
  }
}

async function openMail(row: MailRow) {
  try {
    const detail = await call(() => mailApi().read(plain(row.id)), { ...row })
    selected.value = detail
    showRemoteImages.value = false
    // 有 MIME HTML 就直接按 HTML 阅读；纯文本邮件自动落到纯文本分支
    showHtml.value = Boolean(detail.bodyHtml)
    await loadMails()
    // 阅读即已读，左栏未读计数要跟着变
    await loadFolders()
  } catch (e) {
    log.exception('mail.read', e)
    message.error('读取邮件失败')
  }
}
/** 深链定位：目标可能在别的文件夹或搜索词之外，回到统一收件箱再查；查不到按 id 直接打开。 */
async function applyFocus(id: string): Promise<void> {
  const key = String(id || '')
  if (!key) return
  search.value = ''
  active.value = { kind: 'inbox', label: '统一收件箱' }
  await loadMails()
  const row = mails.value.find((m) => m.id === key)
  if (row) {
    await openMail(row)
    const who = row.fromName || row.fromAddr || '未知发件人'
    await locateFocus(key, '来自仪表盘：' + (row.subject || '（无主题）') + ' · ' + who)
    return
  }
  // 不在当前列表（例如属于某个子文件夹）：直接读正文，至少让人看到这封信
  const detail = await call(() => mailApi().read(plain(key)), null as MailRow | null)
  if (!detail) { missFocus(); return }
  selected.value = detail
  showRemoteImages.value = false
  showHtml.value = Boolean(detail.bodyHtml)
  await loadFolders()
  await locateFocus(key, '来自仪表盘：' + (detail.subject || '（无主题）') + ' · 不在当前列表，已直接打开')
}

function toggleAll(checked: boolean) {
  checkedAll.value = checked
  selectedIds.value = checked ? mails.value.map((m) => m.id) : []
}
function toggleRow(id: string, checked: boolean) {
  selectedIds.value = checked ? [...selectedIds.value, id] : selectedIds.value.filter((x) => x !== id)
}
async function markSelectedRead() {
  // 没勾选时退回「当前打开的这封」：阅读邮件时顺手点工具条的标记已读也算数
  const ids = selectedIds.value.length ? selectedIds.value : selected.value ? [selected.value.id] : []
  if (!ids.length) { message.warning('请先选择邮件'); return }
  try {
    for (const id of ids) await call(() => mailApi().markRead(plain(id)))
    message.success('已标记为已读')
    await loadMails()
    await loadFolders()
  } catch (e) {
    log.exception('mail.markRead', e)
    message.error('操作失败')
  }
}
function removeSelected() {
  const ids = selectedIds.value.length ? selectedIds.value : selected.value ? [selected.value.id] : []
  if (!ids.length) { message.warning('请先选择邮件'); return }
  dialog.warning({
    title: '删除邮件',
    content: '确定删除选中的 ' + ids.length + ' 封邮件？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        for (const id of ids) await call(() => mailApi().remove(plain(id)))
        if (selected.value && ids.includes(selected.value.id)) selected.value = null
        selectedIds.value = []
        message.success('已删除')
        await loadFolders()
        await loadMails()
      } catch (e) {
        log.exception('mail.remove', e)
        message.error('删除失败')
      }
    }
  })
}
async function toggleStar(row: MailRow) {
  try {
    const starred = await call(() => mailApi().toggleStar(plain(row.id)), false)
    row.starred = Boolean(starred)
    if (selected.value?.id === row.id) selected.value = { ...selected.value, starred: Boolean(starred) }
  } catch (e) {
    log.exception('mail.toggleStar', e)
    message.error('操作失败')
  }
}
async function markUnread() {
  if (!selected.value) return
  try {
    // 主进程 schema 是 z.object({ id })，这里必须传对象，传裸字符串会被校验拦掉
    await call(() => mailApi().markUnread(plain({ id: selected.value!.id })), false)
    await loadFolders()
    await loadMails()
    selected.value = null
    message.info('已标记为未读')
  } catch (e) {
    log.exception('mail.markUnread', e)
    message.error('操作失败')
  }
}

const initial = computed(() => {
  const n = selected.value?.fromName || selected.value?.fromAddr || '?'
  return String(n).trim().slice(0, 1).toUpperCase()
})
const fromLabel = computed(() => selected.value?.fromName || selected.value?.fromAddr || '未知发件人')

/**
 * 写邮件/回复不在本应用里做：按账户邮箱域名打开对应服务商网页版，交给系统浏览器。
 * 目标账户优先级：指定账户 → 当前选中账户 → 第一个启用账户。
 */
function openWebmail(accountId?: string | null) {
  const pickAccount = (id?: string | null) => accounts.value.find((a) => a.id === id)
  const acct = pickAccount(accountId) || pickAccount(active.value.accountId) || enabledAccounts.value[0]
  if (!acct) { message.warning('请先在账户管理中添加并启用邮箱账户'); return }
  const url = webmailUrl(acct.email)
  if (!url) { message.warning('该账户邮箱地址无法识别，无法打开网页邮箱'); return }
  void (async () => {
    try {
      await call(() => bridge().system.openExternal({ url }))
    } catch (e) {
      log.exception('mail.webmail', e)
      message.error('打开网页邮箱失败：' + url)
    }
  })()
}
/** 待办能力：与 mail 一样按需从 bridge 取，避免依赖 Api 顶层字段 */
type TodoCreated = { id: string; title: string }
function todoApi(): { create: (dto: Record<string, unknown>) => Promise<IpcEnvelope<TodoCreated>> } {
  return (bridge() as unknown as { todo: { create: (dto: Record<string, unknown>) => Promise<IpcEnvelope<TodoCreated>> } }).todo
}
/** 今天 23:59:59.999：Todo 页「今天」只认 dueAt 落在今天的条目，不给截止时间就看不到 */
function endOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() + 86399000
}
async function toTodo() {
  const cur = selected.value
  if (!cur) return
  try {
    const info = await call(() => mailApi().toTodoInfo(plain(cur.id)), null as unknown as { title: string; from: string; subject: string; body: string } | null)
    if (!info) { message.warning('未找到邮件详情'); return }
    // 正文只截一段做备注，正文全文留在邮件里，避免待办库被大段 HTML 撑爆
    const body = String(info.body || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    const note = ['来自 ' + info.from, body].filter(Boolean).join('\n')
    const created = await call(() => todoApi().create(plain({
      title: info.title || '(无主题)',
      note: note,
      dueAt: endOfToday(),
      priority: '中',
      status: '未开始',
      sourceType: 'mail',
      sourceRef: cur.id
    })), { id: '', title: '' })
    if (!created.id) { message.error('创建待办失败'); return }
    // 侧栏待办计数与 Todo 页都读 store，这里刷新一次即可看到新条目
    await store.refreshTodos()
    message.success('已加入今天待办：' + created.title)
  } catch (e) {
    log.exception('mail.toTodo', e)
    message.error('转为待办失败')
  }
}

async function loadRules() {
  try {
    const rows = await call<Record<string, unknown>[]>(() => mailApi().rules(), [])
    rules.value = rows as unknown as RuleRow[]
  } catch (e) { log.exception('mail.rules', e) }
}
function openRules() {
  showRules.value = true
  void loadRules()
}
function openRule() {
  ruleForm.value = { id: '', name: '', priority: 0, enabled: true, field: 'from', op: 'contains', value: '', actionType: 'label', actionValue: '' }
  showRuleModal.value = true
}
function editRule(r: RuleRow) {
  const cond = Array.isArray(r.conditions) ? (r.conditions[0] as Record<string, unknown> | undefined) : undefined
  const act = Array.isArray(r.actions) ? (r.actions[0] as Record<string, unknown> | undefined) : undefined
  ruleForm.value = {
    id: String(r.id || ''),
    name: String(r.name || ''),
    priority: Number(r.priority || 0),
    enabled: Boolean(r.enabled),
    field: String(cond?.field || 'from'),
    op: String(cond?.op || 'contains'),
    value: String(cond?.value || ''),
    actionType: String(act?.type || 'label'),
    actionValue: String(act?.value || '')
  }
  showRuleModal.value = true
}
function saveRule() {
  const f = ruleForm.value
  if (!f.name.trim() || !f.value.trim()) { message.warning('请填写规则名称与条件值'); return }
  void (async () => {
    try {
      await call(() => mailApi().saveRule(plain({
        id: f.id || undefined,
        name: f.name,
        priority: f.priority,
        enabled: f.enabled,
        conditions: [{ field: f.field, op: f.op, value: f.value }],
        actions: [{ type: f.actionType, value: f.actionValue }]
      })))
      showRuleModal.value = false
      message.success('规则已保存')
      await loadRules()
    } catch (e) {
      log.exception('mail.saveRule', e)
      message.error('保存规则失败')
    }
  })()
}
async function toggleRule(r: RuleRow) {
  try {
    await call(() => mailApi().saveRule(plain({
      id: r.id,
      name: r.name,
      priority: r.priority,
      enabled: !r.enabled,
      conditions: r.conditions || [],
      actions: r.actions || []
    })))
    await loadRules()
  } catch (e) {
    log.exception('mail.saveRule', e)
    message.error('操作失败')
  }
}

/** 账户管理在本页抽屉里完成：面板组件与设置页共用同一套增删改逻辑 */
const showAccounts = ref(false)
function openAccounts() { showAccounts.value = true }

/** 切换自动同步频率：写设置后由主进程的轮询按新值生效 */
async function changeAutoSync(v: number) {
  const next = Number(v) || 0
  autoSyncMin.value = next
  try {
    await settings.save('mail', { autoSyncMin: next })
    message.success(next ? '已改为每 ' + next + ' 分钟自动同步' : '已关闭自动同步')
  } catch (e) {
    log.exception('mail.autoSync', e)
    message.error('保存自动同步频率失败')
  }
}

/** 主进程自动同步完成后会广播 mail 变更；这里刷新账户/文件夹/列表让界面立刻反映 */
let stopDataChanged: (() => void) | null = null
onMounted(async () => {
  await loadAccounts()
  await loadFolders()
  await loadMails()
  await applyFocus(focusKey.value)
  await settings.load()
  const cfg = settings.settings.value
  autoSyncMin.value = Number(cfg.mail?.autoSyncMin ?? 15)
  stopDataChanged = bridge().onDataChanged((p) => {
    if (p.domain !== 'mail') return
    void reloadAll()
  })
})
// 同一页面里再从仪表盘点另一封时重新定位
watch(focusKey, (v) => { void applyFocus(String(v || '')) })
onBeforeUnmount(() => { if (stopDataChanged) stopDataChanged() })
/** 账户抽屉里改完启用状态后走同一条链路：先刷新账户，再按启用清单重算文件夹与列表 */
async function reloadAll() {
  await loadAccounts()
  await loadFolders()
  await loadMails()
}
</script>

<template>
  <Shell>
    <template #subtitle>{{ subtitle }}</template>
    <template #actions>
      <n-select
        size="medium"
        class="ml-auto-sync"
        :value="autoSyncMin"
        :options="autoSyncOptions"
        @update:value="changeAutoSync"
      />
      <n-button size="medium" :loading="loading" @click="syncAll">同步</n-button>
      <n-button size="medium" @click="openRules">收件规则</n-button>
      <n-button size="medium" @click="openAccounts">账户管理</n-button>
      <n-button size="medium" type="primary" @click="openWebmail()">网页邮箱</n-button>
    </template>

    <div class="mail-layout">
      <!-- 左栏：账户与文件夹 -->
      <aside class="card ml-side">
        <!-- 导航行与待办页 .td-nav 同构：图标 + 名称 + 计数，选中态主色反白。
             用 <a> 而不是 n-button，是因为 n-button 自带底色/圆角，压不成待办那种条目。 -->
        <a
          class="side-nav"
          :class="{ on: active.kind === 'inbox' && !active.accountId }"
          href="#"
          @click.prevent="pick({ kind: 'inbox', label: '统一收件箱' })"
        >
          <svg class="mi" aria-hidden="true"><use href="#i-inbox" /></svg>
          <span class="side-nav-label">统一收件箱</span>
          <span v-if="unreadTotal" class="side-nav-count">{{ unreadTotal }}</span>
        </a>

        <template v-for="a in enabledAccounts" :key="a.id">
          <div class="side-nav-group">
            <span>{{ a.alias }}</span>
            <span class="side-nav-sub">{{ a.email }}</span>
          </div>
          <a
            class="side-nav"
            :class="{ on: active.accountId === a.id && active.kind === 'inbox' }"
            href="#"
            @click.prevent="pickFolderByKind(a.id, 'inbox')"
          >
            <svg class="mi" aria-hidden="true"><use href="#i-inbox" /></svg>
            <span class="side-nav-label">收件箱</span>
            <span v-if="unreadOf(a.id)" class="side-nav-count">{{ unreadOf(a.id) }}</span>
          </a>
          <a
            v-for="f in foldersOf(a.id).filter((x) => x.kind !== 'inbox')"
            :key="f.id"
            class="side-nav"
            :class="{ on: active.folderId === f.id }"
            href="#"
            @click.prevent="pickFolder(f)"
          >
            <svg class="mi" aria-hidden="true"><use href="#i-folder" /></svg>
            <span class="side-nav-label">{{ f.name }}</span>
            <span v-if="f.unreadCount" class="side-nav-count">{{ f.unreadCount }}</span>
          </a>
        </template>

        <div class="ml-side-foot">
          <n-button text type="primary" size="small" block @click="openAccounts">账户管理</n-button>
        </div>
      </aside>

      <!-- 中栏：邮件列表 -->
      <section class="card ml-list">
        <div class="ml-tools">
          <n-checkbox :checked="checkedAll" @update:checked="toggleAll" />
          <n-button size="tiny" quaternary title="刷新" @click="loadMails">
            <template #icon><svg class="mi" aria-hidden="true"><use href="#i-refresh" /></svg></template>
          </n-button>
          <span class="ml-spacer"></span>
          <n-button size="tiny" quaternary title="标记已读" @click="markSelectedRead">
            <template #icon><svg class="mi" aria-hidden="true"><use href="#i-ok" /></svg></template>
          </n-button>
          <n-button size="tiny" quaternary title="删除" @click="removeSelected">
            <template #icon><svg class="mi" aria-hidden="true"><use href="#i-trash" /></svg></template>
          </n-button>
        </div>

        <n-input
          v-model:value="search"
          class="ml-search"
          size="small"
          clearable
          placeholder="在当前文件夹中搜索"
          @keyup.enter="loadMails"
          @clear="loadMails"
        />

        <n-alert v-if="hint" :type="hint.type" closable :bordered="false" class="focus-hint" @close="dismissHint">
          <div class="focus-hint-row">
            <span>{{ hint.text }}</span>
            <n-button text size="tiny" @click="dismissHint">清除定位</n-button>
          </div>
        </n-alert>

        <n-spin :show="loading">
          <n-scrollbar class="ml-items">
            <div
              v-for="m in mails"
              :key="m.id"
              class="ml-row"
              :class="{ 'focus-flash': highlightId === m.id }"
              :data-focus-id="m.id"
              :style="selected?.id === m.id && highlightId !== m.id ? { background: 'var(--primary-softer)' } : undefined"
              @click="openMail(m)"
            >
              <span @click.stop>
                <n-checkbox :checked="selectedIds.includes(m.id)" @update:checked="(v: boolean) => toggleRow(m.id, v)" />
              </span>
              <n-button
                class="ml-star"
                size="tiny"
                quaternary
                :type="m.starred ? 'warning' : 'default'"
                title="星标"
                @click.stop="toggleStar(m)"
              >
                <template #icon><svg class="mi" aria-hidden="true"><use href="#i-star" /></svg></template>
              </n-button>
              <div class="ml-body">
                <div class="ml-line">
                  <strong>{{ m.fromName || m.fromAddr || '未知发件人' }}</strong>
                  <time>{{ fmtTime(m.sentAt) }}</time>
                </div>
                <div class="ml-subj">
                  <span v-if="m.important" class="hc-status ml-flag"><i class="hc-dot is-warn" />重要</span>
                  <n-text :depth="m.read ? 3 : 1" :strong="!m.read">{{ m.subject || '（无主题）' }}</n-text>
                </div>
                <div class="ml-sum">
                  <span>{{ m.snippet || '' }}</span>
                  <svg v-if="m.hasAttach" class="mi" aria-hidden="true"><use href="#i-paperclip" /></svg>
                </div>
              </div>
            </div>
            <div v-if="!mails.length" class="ml-empty"><n-empty description="此文件夹暂无邮件" /></div>
          </n-scrollbar>
        </n-spin>
      </section>

      <!-- 右栏：阅读窗格 -->
      <section class="card ml-read">
        <template v-if="selected">
          <div class="ml-tools">
            <n-button size="tiny" quaternary title="在网页邮箱中打开" @click="openWebmail(selected.accountId)">
              <template #icon><svg class="mi" aria-hidden="true"><use href="#i-mail" /></svg></template>
              网页邮箱
            </n-button>
            <n-button size="tiny" quaternary title="星标" :type="selected.starred ? 'warning' : 'default'" @click="toggleStar(selected)">
              <template #icon><svg class="mi" aria-hidden="true"><use href="#i-star" /></svg></template>
            </n-button>
            <n-button size="tiny" quaternary title="删除" @click="removeSelected">
              <template #icon><svg class="mi" aria-hidden="true"><use href="#i-trash" /></svg></template>
            </n-button>
            <span class="ml-spacer"></span>
            <n-button size="tiny" quaternary @click="toTodo">转为待办</n-button>
            <n-button size="tiny" quaternary @click="markUnread">标记未读</n-button>
          </div>

          <n-scrollbar class="ml-content">
            <div class="ml-inner">
              <h2>{{ selected.subject || '（无主题）' }}</h2>
              <div class="ml-from">
                <n-avatar class="ml-avatar" round :size="34">{{ initial }}</n-avatar>
                <div>
                  <strong>{{ fromLabel }}</strong>
                  <span>{{ selected.fromAddr || '' }}</span>
                </div>
                <time>{{ fmtTime(selected.sentAt) }}</time>
              </div>
              <div class="ml-to">
                <span>收件人：{{ selected.toAddrs || '我' }}</span>
                <span v-if="selected.ccAddrs">抄送：{{ selected.ccAddrs }}</span>
              </div>
              <div class="ml-tagline">
                <n-tag v-if="selected.important" size="tiny" type="warning">重要</n-tag>
                <n-tag v-for="l in labelsOf(selected)" :key="l" size="tiny">{{ l }}</n-tag>
              </div>

              <div v-if="selected.bodyHtml" class="ml-safe">
                <svg class="mi" aria-hidden="true"><use href="#i-lock" /></svg>
                <span>远程图片默认拦截，以保护隐私</span>
                <n-button size="tiny" quaternary @click="showRemoteImages = !showRemoteImages">
                  {{ showRemoteImages ? '隐藏图片' : '显示图片' }}
                </n-button>
                <n-button size="tiny" quaternary @click="showHtml = !showHtml">
                  {{ showHtml ? '纯文本' : 'HTML 版' }}
                </n-button>
              </div>

              <!-- 正文用沙箱 iframe 渲染：邮件自带的 style/表格不会泄漏到应用外壳，
                   沙箱不给 allow-scripts，CSP 再兜一层；远程图片未授权时不发请求 -->
              <HtmlBodyFrame
                v-if="showHtml && selected.bodyHtml"
                :html="selected.bodyHtml"
                :allow-remote-images="showRemoteImages"
                title="邮件正文"
              />
              <div v-else class="ml-body-text">{{ selected.bodyText || selected.snippet || '（无正文）' }}</div>

              <div v-for="(att, i) in selected.attachments || []" :key="att.id || att.filename || i" class="ml-attach">
                <span class="ml-attach-ico"><svg class="mi" aria-hidden="true"><use href="#i-paperclip" /></svg></span>
                <div>
                  <strong>{{ att.filename || '未命名附件' }}</strong>
                  <span>{{ fmtSize(att.size) }}</span>
                </div>
              </div>
            </div>
          </n-scrollbar>
        </template>
        <div v-else class="ml-read-empty"><n-empty description="选择左侧邮件开始阅读" /></div>
      </section>
    </div>

    <!-- 邮箱账户抽屉：新增/编辑/测试/删除都在这里，不再跳设置页 -->
    <n-drawer v-model:show="showAccounts" :width="760" placement="right">
      <n-drawer-content title="邮箱账户" closable :native-scrollbar="false">
        <!-- 启用/停用账户后重走一遍加载链：左栏、文件夹、列表都按启用清单重算 -->
        <MailAccountsPanel embedded @changed="reloadAll" />
      </n-drawer-content>
    </n-drawer>

    <!-- 收件规则抽屉 -->
    <n-drawer v-model:show="showRules" :width="420" placement="right">
      <n-drawer-content title="收件规则" closable :native-scrollbar="false">
        <template #footer>
          <n-button size="small" type="primary" block @click="openRule">+ 新建规则</n-button>
        </template>
        <n-empty v-if="!rules.length" description="暂无收件规则" />
        <n-card v-for="r in rules" :key="String(r.id || r.name)" size="small" class="rule-card">
          <div class="rule-row">
            <div class="rule-main">
              <strong>{{ r.name || '未命名规则' }}</strong>
              <span>{{ fmtUnknown(r.conditions) }} → {{ fmtUnknown(r.actions) }}</span>
            </div>
            <n-switch :value="Boolean(r.enabled)" @update:value="toggleRule(r)" />
          </div>
          <div class="rule-foot">
            <n-button text size="tiny" type="primary" @click="editRule(r)">编辑</n-button>
          </div>
        </n-card>
      </n-drawer-content>
    </n-drawer>

    <!-- 规则编辑 -->
    <n-modal v-model:show="showRuleModal" preset="card" title="收件规则" class="ml-modal-sm" :bordered="false">
      <n-form label-placement="left" :label-width="64" size="small">
        <n-form-item label="名称"><n-input v-model:value="ruleForm.name" placeholder="例如：工作邮件加标签" /></n-form-item>
        <n-form-item label="字段"><n-select v-model:value="ruleForm.field" :options="fieldOptions" /></n-form-item>
        <n-form-item label="条件">
          <div class="ml-inline">
            <n-select v-model:value="ruleForm.op" :options="opOptions" />
            <n-input v-model:value="ruleForm.value" placeholder="匹配值" />
          </div>
        </n-form-item>
        <n-form-item label="动作">
          <div class="ml-inline">
            <n-select v-model:value="ruleForm.actionType" :options="actionOptions" />
            <n-input v-model:value="ruleForm.actionValue" placeholder="动作值（如标签名）" />
          </div>
        </n-form-item>
        <n-form-item label="优先级">
          <n-input-number v-model:value="ruleForm.priority" :min="0" :max="100" />
        </n-form-item>
        <n-form-item label="启用"><n-switch v-model:value="ruleForm.enabled" /></n-form-item>
      </n-form>
      <template #footer>
        <div class="dlg-foot">
          <n-button size="small" @click="showRuleModal = false">取消</n-button>
          <n-button size="small" type="primary" @click="saveRule">保存</n-button>
        </div>
      </template>
    </n-modal>
  </Shell>
</template>
