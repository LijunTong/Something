<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NButton, NCheckbox, NInput, NSelect, NTag, NText, NAvatar, NEmpty, NSpin, NScrollbar,
  NModal, NForm, NFormItem, NInputNumber, NDrawer, NDrawerContent, NCard,
  useMessage, useDialog
} from 'naive-ui'
import Shell from '@/components/Shell.vue'
import MailAccountsPanel from '@/components/settings/MailAccountsPanel.vue'
import { call, bridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { MailAccount, MailApi, MailFolder, MailRow } from '@/types/api'
import '@/styles/mail.css'

type FolderPick = { accountId?: string; folderId?: string; kind: string; label: string }
type ComposeForm = { accountId: string | null; to: string; cc: string; subject: string; body: string }
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
const showHtml = ref(false)
const quickReply = ref('')

const showCompose = ref(false)
const compose = ref<ComposeForm>({ accountId: null, to: '', cc: '', subject: '', body: '' })

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

const accountOptions = computed(() =>
  accounts.value.filter((a) => a.enabled).map((a) => ({ label: a.alias + ' <' + a.email + '>', value: a.id }))
)
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
const subtitle = computed(() => '未读 ' + unreadTotal.value + ' · 共 ' + accounts.value.length + ' 个账户 · 最后同步 ' + lastSync.value)

function fmtUnknown(v: unknown): string {
  if (Array.isArray(v)) return v.map(fmtUnknown).filter(Boolean).join('、')
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).map((x) => String(x)).join(' ')
  return v == null ? '' : String(v)
}
function splitAddrs(text: string): string[] {
  return text.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
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
/** 正文 HTML：默认拦截脚本与远程图片，只在用户点「显示图片」后放行 http(s) 图片 */
function safeHtml(html: string | null | undefined): string {
  if (!html) return ''
  let out = String(html)
  out = out.replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  if (!showRemoteImages.value) {
    out = out.replace(/<img([^>]*?)src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '<img$1data-blocked-src=$2')
  }
  return out
}

async function loadAccounts() {
  try {
    accounts.value = normalizeAccounts(await call(() => mailApi().accounts(), [] as MailAccount[]))
  } catch (e) { log.exception('mail.accounts', e) }
}
async function loadFolders() {
  try {
    const all: MailFolder[] = []
    for (const a of normalizeAccounts(accounts.value)) {
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
    showHtml.value = false
    quickReply.value = ''
    await loadMails()
  } catch (e) {
    log.exception('mail.read', e)
    message.error('读取邮件失败')
  }
}
function toggleAll(checked: boolean) {
  checkedAll.value = checked
  selectedIds.value = checked ? mails.value.map((m) => m.id) : []
}
function toggleRow(id: string, checked: boolean) {
  selectedIds.value = checked ? [...selectedIds.value, id] : selectedIds.value.filter((x) => x !== id)
}
async function markSelectedRead() {
  if (!selectedIds.value.length) { message.warning('请先选择邮件'); return }
  try {
    for (const id of selectedIds.value) await call(() => mailApi().markRead(plain(id)))
    message.success('已标记为已读')
    await loadMails()
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
  await loadMails()
  selected.value = null
  message.info('已标记为未读')
}

const initial = computed(() => {
  const n = selected.value?.fromName || selected.value?.fromAddr || '?'
  return String(n).trim().slice(0, 1).toUpperCase()
})
const fromLabel = computed(() => selected.value?.fromName || selected.value?.fromAddr || '未知发件人')

function reply() {
  const cur = selected.value
  if (!cur) return
  openCompose(cur.fromAddr || '', cur.subject ? 'Re: ' + cur.subject : '', '\n\n---- 原邮件 ----\n' + (cur.bodyText || cur.snippet || ''))
}
function forward() {
  const cur = selected.value
  if (!cur) return
  openCompose('', cur.subject ? 'Fwd: ' + cur.subject : '', '\n\n---- 转发邮件 ----\n' + (cur.bodyText || cur.snippet || ''))
}
function openCompose(to = '', subject = '', body = '') {
  compose.value = { accountId: compose.value.accountId ?? accounts.value[0]?.id ?? null, to, cc: '', subject, body }
  showCompose.value = true
}
function composePayload() {
  const c = compose.value
  return {
    accountId: c.accountId as string,
    toAddrs: splitAddrs(c.to),
    ccAddrs: splitAddrs(c.cc),
    subject: c.subject || '(无主题)',
    bodyText: c.body,
    snippet: c.body.slice(0, 120)
  }
}
function sendCompose() {
  const c = compose.value
  if (!c.accountId) { message.warning('请选择发件账户'); return }
  if (!splitAddrs(c.to).length) { message.warning('请填写收件人'); return }
  void (async () => {
    try {
      const r = await call(() => mailApi().send(plain(composePayload())), { ok: false, id: '', delivered: false })
      showCompose.value = false
      if (r.delivered) message.success('邮件已通过 SMTP 发出')
      else message.warning('已保存到「已发送」：该账户未配置 SMTP，未真实投递')
      await loadFolders()
      await loadMails()
    } catch (e) {
      log.exception('mail.send', e)
      message.error('发送失败')
    }
  })()
}
function saveComposeDraft() {
  const c = compose.value
  if (!c.accountId) { message.warning('请选择发件账户'); return }
  void (async () => {
    try {
      await call(() => mailApi().saveDraft(plain(composePayload())))
      message.success('草稿已保存')
      await loadMails()
    } catch (e) {
      log.exception('mail.saveDraft', e)
      message.error('保存草稿失败')
    }
  })()
}
function quickSend() {
  const cur = selected.value
  if (!cur || !quickReply.value.trim()) { message.warning('请输入回复内容'); return }
  openCompose(cur.fromAddr || '', cur.subject ? 'Re: ' + cur.subject : '', quickReply.value)
}
async function toTodo() {
  const cur = selected.value
  if (!cur) return
  try {
    const info = await call(() => mailApi().toTodoInfo(plain(cur.id)), null as unknown as { title: string; from: string; subject: string; body: string } | null)
    if (!info) { message.warning('未找到邮件详情'); return }
    message.info('待办信息：' + info.title + '（来自 ' + info.from + '）')
  } catch (e) {
    log.exception('mail.toTodoInfo', e)
    message.error('提取失败')
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

onMounted(async () => {
  await loadAccounts()
  await loadFolders()
  await loadMails()
})
</script>

<template>
  <Shell>
    <template #subtitle>{{ subtitle }}</template>
    <template #actions>
      <n-button size="small" :loading="loading" @click="syncAll">同步</n-button>
      <n-button size="small" @click="openRules">收件规则</n-button>
      <n-button size="small" @click="openAccounts">账户管理</n-button>
      <n-button size="small" type="primary" @click="openCompose()">写邮件</n-button>
    </template>

    <div class="mail-layout">
      <!-- 左栏：账户与文件夹 -->
      <aside class="card ml-side">
        <n-button
          quaternary
          block
          class="ml-nav"
          :type="active.kind === 'inbox' && !active.accountId ? 'primary' : 'default'"
          @click="pick({ kind: 'inbox', label: '统一收件箱' })"
        >
          <template #icon><svg class="mi" aria-hidden="true"><use href="#i-inbox" /></svg></template>
          <span class="ml-nav-label">统一收件箱</span>
          <n-tag v-if="unreadTotal" size="tiny" :bordered="false">{{ unreadTotal }}</n-tag>
        </n-button>

        <template v-for="a in accounts" :key="a.id">
          <div class="ml-group">
            <span>{{ a.alias }}</span>
            <small>{{ a.email }}</small>
          </div>
          <n-button
            quaternary
            block
            class="ml-nav"
            :type="active.accountId === a.id && active.kind === 'inbox' ? 'primary' : 'default'"
            @click="pickFolderByKind(a.id, 'inbox')"
          >
            <template #icon><svg class="mi" aria-hidden="true"><use href="#i-inbox" /></svg></template>
            <span class="ml-nav-label">收件箱</span>
            <n-tag v-if="unreadOf(a.id)" size="tiny" :bordered="false">{{ unreadOf(a.id) }}</n-tag>
          </n-button>
          <n-button
            v-for="f in foldersOf(a.id).filter((x) => x.kind !== 'inbox')"
            :key="f.id"
            quaternary
            block
            class="ml-nav"
            :type="active.folderId === f.id ? 'primary' : 'default'"
            @click="pickFolder(f)"
          >
            <template #icon><svg class="mi" aria-hidden="true"><use href="#i-folder" /></svg></template>
            <span class="ml-nav-label">{{ f.name }}</span>
            <n-tag v-if="f.unreadCount" size="tiny" :bordered="false">{{ f.unreadCount }}</n-tag>
          </n-button>
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

        <n-spin :show="loading">
          <n-scrollbar class="ml-items">
            <div
              v-for="m in mails"
              :key="m.id"
              class="ml-row"
              :style="selected?.id === m.id ? { background: 'var(--primary-softer)' } : undefined"
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
                  <n-text :depth="m.read ? 3 : 1" :strong="!m.read">{{ m.subject || '（无主题）' }}</n-text>
                </div>
                <div class="ml-sum">
                  <span>{{ m.snippet || '' }}</span>
                  <svg v-if="m.hasAttach" class="mi" aria-hidden="true"><use href="#i-paperclip" /></svg>
                </div>
              </div>
              <n-tag v-if="m.important" size="tiny" type="warning">重要</n-tag>
            </div>
            <div v-if="!mails.length" class="ml-empty"><n-empty description="此文件夹暂无邮件" /></div>
          </n-scrollbar>
        </n-spin>
      </section>

      <!-- 右栏：阅读窗格 -->
      <section class="card ml-read">
        <template v-if="selected">
          <div class="ml-tools">
            <n-button size="tiny" quaternary title="回复" @click="reply">
              <template #icon><svg class="mi" aria-hidden="true"><use href="#i-reply" /></svg></template>
            </n-button>
            <n-button size="tiny" quaternary title="转发" @click="forward">
              <template #icon><svg class="mi" aria-hidden="true"><use href="#i-send" /></svg></template>
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

              <!-- 正文 HTML 先过滤脚本与事件属性；远程图片在未授权时替换为 data 属性 -->
              <div v-if="showHtml && selected.bodyHtml" class="ml-html" v-html="safeHtml(selected.bodyHtml)"></div>
              <div v-else class="ml-body-text">{{ selected.bodyText || selected.snippet || '（无正文）' }}</div>

              <div v-for="(att, i) in selected.attachments || []" :key="att.id || att.filename || i" class="ml-attach">
                <span class="ml-attach-ico"><svg class="mi" aria-hidden="true"><use href="#i-paperclip" /></svg></span>
                <div>
                  <strong>{{ att.filename || '未命名附件' }}</strong>
                  <span>{{ fmtSize(att.size) }}</span>
                </div>
              </div>

              <div class="ml-reply">
                <n-input v-model:value="quickReply" size="small" placeholder="快速回复…" />
                <n-button size="small" type="primary" @click="quickSend">回复</n-button>
              </div>
            </div>
          </n-scrollbar>
        </template>
        <div v-else class="ml-read-empty"><n-empty description="选择左侧邮件开始阅读" /></div>
      </section>
    </div>

    <!-- 写邮件 -->
    <n-modal v-model:show="showCompose" preset="card" title="新邮件" class="ml-modal" :bordered="false">
      <n-form label-placement="left" :label-width="56" size="small">
        <n-form-item label="发件">
          <n-select v-model:value="compose.accountId" :options="accountOptions" placeholder="选择发件账户" />
        </n-form-item>
        <n-form-item label="收件人">
          <n-input v-model:value="compose.to" placeholder="多个地址用逗号分隔" />
        </n-form-item>
        <n-form-item label="抄送"><n-input v-model:value="compose.cc" placeholder="可选" /></n-form-item>
        <n-form-item label="主题"><n-input v-model:value="compose.subject" placeholder="邮件主题" /></n-form-item>
        <n-form-item label="正文">
          <n-input v-model:value="compose.body" type="textarea" :autosize="{ minRows: 8, maxRows: 16 }" placeholder="正文" />
        </n-form-item>
      </n-form>
      <template #footer>
        <div class="dlg-foot">
          <n-button size="small" @click="saveComposeDraft">保存草稿</n-button>
          <n-button size="small" @click="showCompose = false">取消</n-button>
          <n-button size="small" type="primary" @click="sendCompose">发送</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 邮箱账户抽屉：新增/编辑/测试/删除都在这里，不再跳设置页 -->
    <n-drawer v-model:show="showAccounts" :width="760" placement="right">
      <n-drawer-content title="邮箱账户" closable :native-scrollbar="false">
        <MailAccountsPanel embedded @changed="loadAccounts().then(loadFolders).then(loadMails)" />
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
