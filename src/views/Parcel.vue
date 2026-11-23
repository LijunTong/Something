<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  NAlert, NButton, NDrawer, NDrawerContent, NEmpty, NForm, NFormItem,
  NInput, NModal, NSelect, NSpace, NSpin, NSwitch, NTabPane, NTabs, NTag, NTimeline,
  NTimelineItem, useDialog, useMessage
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import Shell from '@/components/Shell.vue'
import { bridge, call, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useFocusQuery } from '@/composables/useFocusQuery'
import ParcelSourcePanel from '@/components/settings/ParcelSourcePanel.vue'
import type { ParcelProvider, ParcelRefreshAllResult, ParcelRefreshResult, ParcelTrack, ParcelRow } from '@/types/api'
import '@/styles/parcel.css'

type ParcelApiBridge = typeof window.api & {
  parcel: {
    list(dto?: { status?: string; archived?: boolean }): Promise<{ ok: boolean; data?: ParcelRow[]; error?: { code: string; message: string } }>
    add(dto: { numbers: string[]; alias?: string; note?: string; company?: string; phoneTail?: string }): Promise<{ ok: boolean; data?: ParcelRow[]; error?: { code: string; message: string } }>
    get(id: string): Promise<{ ok: boolean; data?: ParcelRow | null; error?: { code: string; message: string } }>
    refresh(dto: string | { id: string; company?: string; phoneTail?: string }): Promise<{ ok: boolean; data?: ParcelRefreshResult; error?: { code: string; message: string } }>
    refreshAll(dto?: { force?: boolean }): Promise<{ ok: boolean; data?: ParcelRefreshAllResult; error?: { code: string; message: string } }>
    providers(): Promise<{ ok: boolean; data?: ParcelProvider[]; error?: { code: string; message: string } }>
    companies(): Promise<{ ok: boolean; data?: Array<{ name: string; short: string }>; error?: { code: string; message: string } }>
    tracks(id: string): Promise<{ ok: boolean; data?: ParcelTrack[]; error?: { code: string; message: string } }>
    archive(id: string): Promise<{ ok: boolean; data?: boolean; error?: { code: string; message: string } }>
    togglePrivacy(dto: { id: string; masked: boolean }): Promise<{ ok: boolean; data?: boolean; error?: { code: string; message: string } }>
    toTodoInfo(id: string): Promise<{ ok: boolean; data?: { title: string; dueAt: number | null; note: string }; error?: { code: string; message: string } }>
  }
}

const store = useAppStore()
const api = bridge() as ParcelApiBridge
const message = useMessage()
const dialog = useDialog()

const TAB_ALL = '全部'
const STATUS_TABS = [TAB_ALL, '在途', '派送中', '待取件', '已签收'] as const
type StatusTab = typeof STATUS_TABS[number]
const STALE_HOURS = 48

function isStatusTab(value: string): value is StatusTab {
  return (STATUS_TABS as readonly string[]).includes(value)
}

// 页面不再内置示例包裹/轨迹：数据全部来自本机数据库与快递接口
const rows = ref<ParcelRow[]>([])
const loading = ref(false)
const activeTab = ref<string>(TAB_ALL)
const showTrack = ref(false)
const showAdd = ref(false)
const selected = ref<ParcelRow | null>(null)
const tracks = ref<ParcelTrack[]>([])
const trackLoading = ref(false)
const adding = ref(false)
const privacyOn = ref(false)
const lastRefresh = ref<number | null>(null)
const addForm = ref({ numbers: '', alias: '', note: '', company: '', phoneTail: '' })
const showSource = ref(false)
const providers = ref<ParcelProvider[]>([])
const companies = ref<Array<{ name: string; short: string }>>([])
let offData: (() => void) | null = null
// 深链定位：仪表盘点某个包裹 → /parcel?focus=<id>，落地后打开轨迹抽屉并把卡片滚到中间
const {
  focusId: focusKey,
  hint: hint,
  highlight: highlightId,
  locate: locateFocus,
  miss: missFocus,
  dismiss: dismissHint
} = useFocusQuery()

const counts = computed<Record<StatusTab, number>>(() => {
  const result: Record<StatusTab, number> = { 全部: 0, 在途: 0, 派送中: 0, 待取件: 0, 已签收: 0 }
  for (const row of rows.value) {
    if (row.archived) continue
    if (isStatusTab(row.status)) result[row.status] += 1
    result[TAB_ALL] += 1
  }
  return result
})

const visibleRows = computed(() => {
  const list = rows.value.filter((row) => !row.archived)
  return activeTab.value === TAB_ALL ? list : list.filter((row) => row.status === activeTab.value)
})

const pickupCount = computed(() => counts.value['待取件'])
const allCount = computed(() => counts.value[TAB_ALL])

const staleRows = computed(() => {
  const cutoff = Date.now() - STALE_HOURS * 3600000
  return visibleRows.value.filter((row) => row.status !== '已签收' && row.updatedAt < cutoff)
})

const refreshSuffix = computed(() => {
  if (lastRefresh.value === null) return ''
  return ' · 最后刷新 ' + relativeTime(lastRefresh.value)
})

const subtitle = computed(() => '共 ' + allCount.value + ' 个包裹 · ' + pickupCount.value + ' 个待取件' + refreshSuffix.value)

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function shortNo(no: string): string {
  const clean = no.trim()
  if (clean.length <= 12) return clean
  return clean.slice(0, 6) + '****' + clean.slice(-4)
}

function maskedNo(no: string): string {
  const clean = no.trim()
  return clean.length <= 4 ? '****' : '****' + clean.slice(-4)
}

/** 全局开关与服务端的行级 privacyMasked 任一开启，都按脱敏展示。 */
function isPrivate(row: ParcelRow): boolean {
  return privacyOn.value || row.privacyMasked
}

function displayNo(row: ParcelRow): string {
  return isPrivate(row) ? maskedNo(row.trackingNo) : shortNo(row.trackingNo)
}

function maskedValue(value: string | null, fallback: string): string {
  return value ? '****' : fallback
}

function statusType(status: string): 'default' | 'success' | 'warning' | 'info' {
  if (status === '待取件') return 'warning'
  if (status === '派送中') return 'info'
  if (status === '已签收') return 'success'
  return 'default'
}

function companyShort(name: string): string {
  if (name === '顺丰速运') return 'SF'
  if (name === '中通快递') return 'ZT'
  if (name === '京东物流') return 'JD'
  if (name === '圆通速递') return 'YT'
  return name.slice(0, 2)
}

function keyText(row: ParcelRow): string {
  if (row.status === '待取件') return '取件码 ' + (isPrivate(row) ? maskedValue(row.pickupCode, '待生成') : (row.pickupCode || '待生成'))
  if (row.status === '派送中') return '派送中，预计今天送达'
  if (row.status === '已签收') return '已签收：本人签收'
  return '预计 ' + relativeTime(row.etaAt ?? row.updatedAt) + '送达'
}

function keySub(row: ParcelRow): string {
  if (row.status === '待取件') return isPrivate(row) ? maskedValue(row.station, '取件点待确认') : (row.station || '取件点待确认')
  if (row.status === '派送中') return '快递员联系方式已隐藏'
  if (row.status === '已签收') return '签收时间 ' + formatTime(row.updatedAt)
  return '最新：' + (tracks.value.find((t) => t.parcelId === row.id)?.description || '运输中')
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const list = await call(() => api.parcel.list({ archived: false }), [] as ParcelRow[])
    rows.value = list
  } catch (e) {
    log.exception('parcel.load', e)
    message.error('加载快递失败：' + errMsg(e))
    rows.value = []
  } finally {
    loading.value = false
  }
}

async function loadProviders(): Promise<void> {
  try {
    providers.value = await call(() => api.parcel.providers(), [] as ParcelProvider[])
    companies.value = await call(() => api.parcel.companies(), [] as Array<{ name: string; short: string }>)
  } catch (e) {
    log.exception('parcel.providers', e)
  }
}

/** 当前数据源的中文名；未装桥或还没加载时为「手动维护」 */
function providerLabel(): string {
  const item = providers.value.find((p) => p.active)
  if (!item) return '手动维护'
  return item.id === 'manual' ? '手动维护' : item.name
}

const companySelectOptions = computed(() => [{ label: '按单号自动识别', value: '' }].concat(companies.value.map((c) => ({ label: c.name, value: c.name }))))

/** 卡片上只用一句话提示上次失败原因，完整原文放 title 与详情抽屉 */
function lastErrorText(row: ParcelRow): string {
  const raw = String(row.lastError || '')
  if (!raw) return ''
  const idx = raw.indexOf('|')
  return idx >= 0 ? raw.slice(idx + 1) : raw
}

async function refreshAll(): Promise<void> {
  const targets = visibleRows.value
  if (!targets.length) { message.info('当前没有可刷新的包裹'); return }
  loading.value = true
  try {
    // 统一交给主进程批量刷新：并发 3、只查未签收，失败原因逐条汇总后再回页面
    const result = await call(() => api.parcel.refreshAll({ force: true }), null as unknown as ParcelRefreshAllResult | null)
    await load()
    const cur = selected.value
    if (cur) {
      const fresh = rows.value.find((row) => row.id === cur.id)
      if (fresh) await openTrack(fresh)
    }
    lastRefresh.value = Date.now()
    if (!result) { message.info('已刷新，状态暂无变化'); return }
    if (result.failed > 0) {
      const reason = result.errors && result.errors.length ? result.errors[0] : '详见包裹卡片上的失败提示'
      message.warning('刷新 ' + result.total + ' 个：' + result.changed + ' 个状态变化，' + result.failed + ' 个失败（' + reason + '）')
    } else if (result.added > 0 || result.changed > 0) {
      message.success('已刷新 ' + result.total + ' 个包裹：新增 ' + result.added + ' 条轨迹，' + result.changed + ' 个状态变化')
    } else {
      message.info('已刷新 ' + result.total + ' 个包裹，状态暂无变化（数据源：' + providerLabel() + '）')
    }
  } catch (e) {
    log.exception('parcel.refreshAll', e)
    message.error('刷新失败：' + errMsg(e))
  } finally {
    loading.value = false
  }
}

async function openTrack(row: ParcelRow): Promise<void> {
  selected.value = row
  showTrack.value = true
  trackLoading.value = true
  try {
    tracks.value = await call(() => api.parcel.tracks(row.id), [] as ParcelTrack[])
  } catch (e) {
    log.exception('parcel.tracks', e)
    tracks.value = []
    message.error('加载轨迹失败：' + errMsg(e))
  } finally {
    trackLoading.value = false
  }
}

/** 深链定位：目标可能落在别的状态页签或被归档隐藏，先回到「全部」再按 id 兜底查一次。 */
async function applyFocus(id: string): Promise<void> {
  const key = String(id || '')
  if (!key) return
  activeTab.value = TAB_ALL
  await load()
  let row = rows.value.find((r) => r.id === key)
  if (!row) {
    const one = await call(() => api.parcel.get(key), null as ParcelRow | null)
    if (one) {
      rows.value = [one].concat(rows.value)
      row = one
    }
  }
  if (!row) { missFocus(); return }
  await openTrack(row)
  await locateFocus(key, '来自仪表盘：' + row.company + ' ' + displayNo(row))
}

/** 单条刷新：结果显示在抽屉里；失败如实提示，不推进状态、不伪造轨迹 */
async function refreshOne(row: ParcelRow): Promise<void> {
  try {
    const result = await call(() => api.parcel.refresh(row.id), null as unknown as ParcelRefreshResult | null)
    if (!result) { message.info('刷新完成，状态暂无变化'); return }
    if (result.error) {
      message.warning(result.error.message)
      if (result.parcel) {
        const next = result.parcel
        rows.value = rows.value.map((item) => (item.id === next.id ? next : item))
        if (selected.value?.id === next.id) selected.value = next
      }
      return
    }
    const updated = result.parcel
    if (!updated) return
    rows.value = rows.value.map((item) => (item.id === updated.id ? updated : item))
    if (selected.value?.id === updated.id) selected.value = updated
    lastRefresh.value = Date.now()
    await openTrack(updated)
    if (result.added > 0) message.success('已新增 ' + result.added + ' 条轨迹')
    else message.info('已刷新，暂无新轨迹')
  } catch (e) {
    log.exception('parcel.refreshOne', e)
    message.error('刷新失败：' + errMsg(e))
  }
}

/** 行级隐私：回写服务端标记，卡片据该标记显示脱敏态。 */
async function toggleRowPrivacy(row: ParcelRow, masked: boolean): Promise<void> {
  try {
    await call(() => api.parcel.togglePrivacy(plain({ id: row.id, masked })), true)
    rows.value = rows.value.map((item) => (item.id === row.id ? { ...item, privacyMasked: masked } : item))
    message.success(masked ? '已隐藏该单号' : '已恢复该单号')
  } catch (e) {
    log.exception('parcel.togglePrivacy', e)
    message.error('隐私设置失败：' + errMsg(e))
  }
}

async function archiveOne(row: ParcelRow): Promise<void> {
  try {
    await call(() => api.parcel.archive(row.id), true)
    rows.value = rows.value.filter((item) => item.id !== row.id)
    showTrack.value = false
    selected.value = null
    message.success('包裹已归档')
  } catch (e) {
    log.exception('parcel.archive', e)
    message.error('归档失败：' + errMsg(e))
  }
}

async function copyNo(row: ParcelRow): Promise<void> {
  const text = isPrivate(row) ? maskedNo(row.trackingNo) : row.trackingNo
  try {
    await navigator.clipboard.writeText(text)
    message.success('单号已复制')
  } catch (e) {
    log.exception('parcel.copy', e)
    message.error('复制失败，请手动选择单号')
  }
}

async function toTodo(row: ParcelRow): Promise<void> {
  try {
    const info = await call(() => api.parcel.toTodoInfo(row.id), {
      title: '取' + row.company + '快递',
      dueAt: row.etaAt,
      note: '快递单号 ' + row.trackingNo + (row.pickupCode ? '；取件码 ' + row.pickupCode : '') + (row.station ? '；' + row.station : '')
    })
    await store.addTodo(info.title, { dueAt: info.dueAt, note: info.note, sourceType: 'parcel', sourceRef: row.id })
    message.success('已生成取件待办')
  } catch (e) {
    log.exception('parcel.toTodo', e)
    message.error('生成待办失败：' + errMsg(e))
  }
}

function confirmArchive(row: ParcelRow): void {
  dialog.warning({
    title: '归档包裹',
    content: '确定归档「' + row.company + ' · ' + displayNo(row) + '」？',
    positiveText: '归档',
    negativeText: '取消',
    onPositiveClick: () => archiveOne(row)
  })
}

function openAdd(): void {
  addForm.value = { numbers: '', alias: '', note: '', company: '', phoneTail: '' }
  showAdd.value = true
}

async function addParcels(): Promise<void> {
  const numbers = addForm.value.numbers.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean)
  if (!numbers.length) { message.warning('请至少输入一个快递单号'); return }
  adding.value = true
  try {
    const created = await call(() => api.parcel.add(plain({ numbers, alias: addForm.value.alias || undefined, note: addForm.value.note || undefined, company: addForm.value.company || undefined, phoneTail: addForm.value.phoneTail.trim() || undefined })), [] as ParcelRow[])
    if (!created.length) {
      message.warning('快递接口没有返回包裹，请确认单号与网络后重试')
    } else {
      rows.value = [...created, ...rows.value]
      message.success('已添加 ' + created.length + ' 个包裹')
      if (providerLabel() === '手动维护') message.info('当前为手动维护：到右上角「数据源」选好接口后刷新，就能自动查轨迹')
    }
    showAdd.value = false
  } catch (e) {
    log.exception('parcel.add', e)
    message.error('添加失败：' + errMsg(e))
  } finally {
    adding.value = false
  }
}

onMounted(async () => {
  await load()
  await loadProviders()
  // 主进程自动刷新或其它窗口写入后，列表与数据源状态一起跟上
  offData = bridge().onDataChanged((p) => {
    if (p.domain === 'parcel') void load()
    if (p.domain === 'settings') void loadProviders()
  })
  await applyFocus(focusKey.value)
})
onUnmounted(() => { offData?.(); offData = null })
// 同一页面里再从仪表盘点另一个包裹时重新定位
watch(focusKey, (v) => { void applyFocus(String(v || '')) })
</script>

<template>
  <Shell>
    <template #subtitle>{{ subtitle }}</template>
    <template #actions>
      <n-button size="medium" @click="showSource = true">数据源 · {{ providerLabel() }}</n-button>
      <n-button size="medium" :loading="loading" @click="refreshAll">全部刷新</n-button>
      <n-button size="medium" type="primary" @click="openAdd">添加单号</n-button>
      <span class="privacy-toggle"><span>隐私模式</span><n-switch :value="privacyOn" size="small" @update:value="privacyOn = $event" /></span>
    </template>

    <n-tabs v-model:value="activeTab" type="line" animated size="small" class="pc-tabs">
      <n-tab-pane v-for="tab in STATUS_TABS" :key="tab" :name="tab">
        <template #tab>{{ tab }} <n-tag size="tiny" :bordered="false">{{ counts[tab] }}</n-tag></template>
      </n-tab-pane>
    </n-tabs>

    <n-alert v-if="hint" :type="hint.type" closable :bordered="false" class="focus-hint" @close="dismissHint">
      <div class="focus-hint-row">
        <span>{{ hint.text }}</span>
        <n-button text size="tiny" @click="dismissHint">清除定位</n-button>
      </div>
    </n-alert>

    <n-alert v-if="staleRows.length" type="warning" class="pc-alert" :bordered="false">
      <template #default>
        <span>{{ staleRows.length }} 个包裹超过 48 小时无物流更新</span>
        <n-button size="tiny" quaternary type="warning" @click="openTrack(staleRows[0])">查看详情</n-button>
      </template>
    </n-alert>

    <n-spin :show="loading">
      <div class="pc-grid">
        <article
          v-for="row in visibleRows"
          :key="row.id"
          class="card pc-card"
          :class="{ 'pc-card-muted': row.status === '已签收', 'focus-flash': highlightId === row.id }"
          :data-focus-id="row.id"
        >
          <div class="pc-card-head">
            <span class="pc-logo">{{ companyShort(row.company) }}</span>
            <strong>{{ row.company }}</strong>
            <n-tag size="small" :type="statusType(row.status)" :bordered="false">{{ row.status }}</n-tag>
          </div>
          <div class="pc-card-num">
            <span>{{ displayNo(row) }}</span>
            <n-button size="tiny" quaternary @click="copyNo(row)">复制</n-button>
          </div>
          <div class="pc-card-key">
            <strong>{{ keyText(row) }}</strong>
            <span>{{ keySub(row) }}</span>
          </div>
          <div class="pc-card-foot">
            <span>更新 {{ formatTime(row.updatedAt) }}</span>
            <div class="pc-card-actions">
              <n-tag v-if="lastErrorText(row)" size="tiny" type="error" :bordered="false" :title="lastErrorText(row)">{{ lastErrorText(row).slice(0, 12) }}</n-tag>
              <n-switch :value="row.privacyMasked" size="small" @update:value="(masked: boolean) => toggleRowPrivacy(row, masked)" />
              <n-tag size="tiny" :bordered="false" :type="row.privacyMasked ? 'warning' : 'success'">{{ row.privacyMasked ? '已脱敏' : '未脱敏' }}</n-tag>
              <n-button size="tiny" quaternary type="primary" @click="openTrack(row)">查看轨迹</n-button>
            </div>
          </div>
        </article>
      </div>
      <n-empty v-if="!visibleRows.length && !loading" class="pc-empty" description="还没有添加快递" size="large">
        <template #extra><n-button size="small" type="primary" @click="openAdd">+ 添加第一个单号</n-button></template>
      </n-empty>
    </n-spin>

    <n-drawer v-model:show="showTrack" :width="420" placement="right">
      <n-drawer-content :title="selected ? selected.company + ' · ' + displayNo(selected) : '物流轨迹'" closable :native-scrollbar="false">
        <template #default>
        <n-spin :show="trackLoading">
          <div v-if="selected" class="pc-drawer-info">
            <n-tag size="small" :type="statusType(selected.status)" :bordered="false">{{ selected.status }}</n-tag>
            <div class="field"><span class="k">快递公司</span><span class="v">{{ selected.company }}</span></div>
            <div class="field"><span class="k">数据源</span><span class="v">{{ providerLabel() }}{{ selected.lastSyncAt ? ' · 同步于 ' + formatTime(selected.lastSyncAt) : ' · 尚未同步' }}</span></div>
            <div class="field"><span class="k">取件点</span><span class="v">{{ isPrivate(selected) ? '****' : (selected.station || '—') }}</span></div>
            <div v-if="lastErrorText(selected)" class="field"><span class="k">上次失败</span><span class="v">{{ lastErrorText(selected) }}</span></div>
            <div class="pc-track-title">物流轨迹</div>
            <n-empty v-if="!tracks.length" description="暂无轨迹记录" size="small" />
            <n-timeline v-else>
              <n-timeline-item
                v-for="(item, index) in tracks"
                :key="item.id + '-' + item.nodeTime"
                :type="index === 0 ? 'success' : 'default'"
                :title="item.description"
                :content="item.location || ''"
                :time="formatTime(item.nodeTime)"
              />
            </n-timeline>
          </div>
        </n-spin>
        </template>
        <template #footer>
          <n-space>
            <n-button size="small" :loading="loading" @click="selected && refreshOne(selected)">刷新轨迹</n-button>
            <n-button size="small" @click="selected && toTodo(selected)">生成取件待办</n-button>
            <n-button size="small" @click="selected && confirmArchive(selected)">归档</n-button>
          </n-space>
        </template>
      </n-drawer-content>
    </n-drawer>

    <n-drawer v-model:show="showSource" :width="680" placement="right">
      <n-drawer-content title="快递数据源" closable :native-scrollbar="false">
        <ParcelSourcePanel embedded />
      </n-drawer-content>
    </n-drawer>

    <n-modal v-model:show="showAdd" preset="card" title="添加快递" style="width:460px">
      <n-form label-placement="left" label-width="48" size="small">
        <n-form-item label="单号">
          <n-input v-model:value="addForm.numbers" type="textarea" :autosize="{ minRows: 3 }" placeholder="粘贴或输入快递单号，每行一个" />
        </n-form-item>
        <n-form-item label="公司">
          <n-select v-model:value="addForm.company" :options="companySelectOptions" placeholder="默认按单号自动识别" clearable />
        </n-form-item>
        <n-form-item label="后四位">
          <n-input v-model:value="addForm.phoneTail" maxlength="4" placeholder="手机号后四位，顺丰等需要（可选）" />
        </n-form-item>
        <n-form-item label="别名"><n-input v-model:value="addForm.alias" placeholder="如：双十一耳机" /></n-form-item>
        <n-form-item label="备注"><n-input v-model:value="addForm.note" placeholder="可选" /></n-form-item>
      </n-form>
      <template #footer>
        <div class="pc-modal-foot">
          <n-button size="small" @click="showAdd = false">取消</n-button>
          <n-button size="small" type="primary" :loading="adding" @click="addParcels">添加</n-button>
        </div>
      </template>
    </n-modal>
  </Shell>
</template>