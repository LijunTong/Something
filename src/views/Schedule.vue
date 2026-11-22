<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useMessage, useDialog, NButton, NInput, NSelect, NModal, NForm, NFormItem, NDrawer, NDrawerContent, NSpace, NCalendar, NTag, NCheckbox, NEmpty, NDatePicker, NAlert } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import Shell from '@/components/Shell.vue'
import { call, bridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useFocusQuery } from '@/composables/useFocusQuery'
import type { ScheduleRow, CalendarRow } from '@/types/api'
import '@/styles/schedule.css'

const store = useAppStore()
const message = useMessage()
const dialog = useDialog()

// 深链定位：仪表盘点某条日程 → /schedule?focus=<id>&at=<startAt>，落地后切到那天、打开抽屉并高亮
const {
  focusId: focusKey,
  focusAt: focusAtQuery,
  hint: hint,
  highlight: highlightId,
  locate: locateFocus,
  miss: missFocus,
  dismiss: dismissHint
} = useFocusQuery()
/** 实际命中的那一次实例时间（重复日程同一个 id 有多条），优先于 query 里的 at */
const focusedAt = ref('')
function isFocused(e: ScheduleRow): boolean {
  if (highlightId.value !== e.id) return false
  const key = String(e.instanceAt ?? e.startAt)
  if (focusedAt.value) return key === focusedAt.value
  if (focusAtQuery.value) return key === focusAtQuery.value
  return true
}

const events = ref<ScheduleRow[]>([])
const mixCalendars = ref<CalendarRow[]>([])
const calValue = ref<number>(Date.now())
const panelYear = ref(new Date().getFullYear())
const panelMonth = ref(new Date().getMonth() + 1)
const selected = ref<ScheduleRow | null>(null)
const showDrawer = ref(false)
const showModal = ref(false)
/** 有值表示正在编辑这条日程，为空表示新建 */
const editingId = ref<string | null>(null)
const showList = ref(false)
const conflicts = ref<string[]>([])
const form = ref({
  title: '',
  startAt: null as number | null,
  endAt: null as number | null,
  place: '',
  calendarId: null as string | null,
  remindMin: 10,
  recurRule: 'none',
  note: ''
})

// 日历分类只来自本机数据库，页面不再内置示例分类
const calendars = computed(() => mixCalendars.value)

const monthLabel = computed(() => panelYear.value + ' 年 ' + panelMonth.value + ' 月')
const monthEvents = computed(() => events.value)

function monthRange(year: number, month: number) {
  const from = new Date(year, month - 1, 1).getTime()
  const to = new Date(year, month, 0, 23, 59, 59).getTime()
  return { from, to }
}

function keyOf(ts: number) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}
const eventsByDay = computed(() => {
  const map: Record<string, ScheduleRow[]> = {}
  for (const e of events.value) {
    const k = keyOf(e.instanceAt ?? e.startAt)
    if (!map[k]) map[k] = []
    map[k].push(e)
  }
  for (const k in map) map[k].sort((a, b) => (a.instanceAt ?? a.startAt) - (b.instanceAt ?? b.startAt))
  return map
})

function eventsOfDay(year: number, month: number, date: number) {
  return eventsByDay.value[year + '-' + month + '-' + date] || []
}

function fmtTime(ts: number) {
  const d = new Date(ts)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
/** 把时间戳格式化成 YYYY年M月D日。数值参数，避免把响应式对象直接交给 Date。 */
function fmtDateFull(e: ScheduleRow) {
  const ts = Number(e.instanceAt ?? e.startAt)
  const d = new Date(ts)
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
}

function fmtRange(e: ScheduleRow) {
  const st = e.instanceAt ?? e.startAt
  const en = e.instanceAt ? e.instanceAt + (e.endAt - e.startAt) : e.endAt
  return fmtTime(st) + ' - ' + fmtTime(en)
}
function colorOf(e: ScheduleRow) {
  const n = e.calendarName || ''
  if (n === '个人') return 'orange'
  if (n === '学习') return 'green'
  return 'blue'
}

async function load() {
  const r = monthRange(panelYear.value, panelMonth.value)
  events.value = await call(() => bridge().schedule.range({ from: r.from, to: r.to }), [] as ScheduleRow[])
  const cals = await call(() => bridge().schedule.calendars(), [] as CalendarRow[])
  // 服务端 visible 可能是 0/1，统一转成布尔供 n-checkbox 使用
  mixCalendars.value = cals.map((c) => ({ ...c, visible: c.visible !== false && (c.visible as unknown) !== 0 }))
  detectConflicts()
}

function detectConflicts() {
  const list: string[] = []
  for (const k in eventsByDay.value) {
    const evs = eventsByDay.value[k]
    for (let i = 0; i < evs.length - 1; i++) {
      const a = evs[i]
      const b = evs[i + 1]
      if ((a.instanceAt ?? a.startAt) + (a.endAt - a.startAt) > (b.instanceAt ?? b.startAt)) {
        list.push(a.title + ' 与「' + b.title + '」时间冲突')
      }
    }
  }
  conflicts.value = Array.from(new Set(list))
}

function onPanelChange(info: { year: number; month: number }) {
  if (info.year === panelYear.value && info.month === panelMonth.value) return
  panelYear.value = info.year
  panelMonth.value = info.month
  void load()
}

function onPick(v: number) {
  calValue.value = v
}

function goToday() {
  const now = new Date()
  calValue.value = now.getTime()
  panelYear.value = now.getFullYear()
  panelMonth.value = now.getMonth() + 1
  void load()
}

async function toggleCal(c: CalendarRow) {
  // 用当前值取反；失败时不静默覆盖成本地旧值，而是提示并回滚勾选状态
  const next = !c.visible
  try {
    const rows = await call(() => bridge().schedule.toggleCalendar({ id: c.id, visible: next }))
    mixCalendars.value = rows
    await load()
  } catch (e) {
    message.error((e as Error).message)
    await load()
  }
}

function openEvent(e: ScheduleRow) { selected.value = e; showDrawer.value = true }

/** 深链定位：目标可能在别的月份，先按 id 取真实开始时间，切月重载后再打开抽屉。 */
async function applyFocus(id: string, at?: string): Promise<void> {
  const key = String(id || '')
  if (!key) return
  const listed = events.value.find((e) => e.id === key)
  const one = listed || (await call(() => bridge().schedule.get(key), null as ScheduleRow | null))
  if (!one) { missFocus(); return }
  const start = Number(at || 0) || Number(one.instanceAt ?? one.startAt) || Date.now()
  const d = new Date(start)
  calValue.value = start
  focusedAt.value = ''
  if (d.getFullYear() !== panelYear.value || d.getMonth() + 1 !== panelMonth.value) {
    panelYear.value = d.getFullYear()
    panelMonth.value = d.getMonth() + 1
  }
  await load()
  let target = events.value.find((e) => e.id === key && String(e.instanceAt ?? e.startAt) === String(start))
  if (!target) target = events.value.find((e) => e.id === key)
  if (!target) { missFocus(); return }
  focusedAt.value = String(target.instanceAt ?? target.startAt)
  openEvent(target)
  await locateFocus(key, '来自仪表盘：' + target.title + ' · ' + fmtDateFull(target), focusedAt.value)
}

/** 新建一律默认今天：开始取此刻，结束取今天 23:59。
    之前是「按月视图里选中的那天预填」，只要先在日历里点过某天（或深链定位切过日期），
    再点新建就落到那天去，看起来像是新建到了昨天。默认值不该受历史选择影响。 */
function openCreate() {
  editingId.value = null
  const now = new Date()
  const startAt = now.getTime()
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0).getTime()
  const endAt = dayEnd > startAt ? dayEnd : startAt + 3600000
  form.value = {
    title: '',
    startAt,
    endAt,
    place: '',
    calendarId: calendars.value[0]?.id ?? null,
    remindMin: 10,
    recurRule: 'none',
    note: ''
  }
  conflicts.value = []
  showModal.value = true
}

/** 详情抽屉里的「编辑」：把当前值填进同一个弹窗，保存时走 update。 */
function openEdit(e: ScheduleRow) {
  editingId.value = e.id
  const start = e.instanceAt ?? e.startAt
  form.value = {
    title: e.title,
    startAt: start,
    endAt: start + (e.endAt - e.startAt),
    place: e.place || '',
    calendarId: e.calendarId,
    remindMin: e.remindMin,
    recurRule: e.recurRule || 'none',
    note: e.note || ''
  }
  conflicts.value = []
  showDrawer.value = false
  showModal.value = true
}

async function recheck() {
  const s = form.value.startAt
  const e = form.value.endAt
  if (!s || !e || e <= s) { conflicts.value = []; return }
  const rows = await call(() => bridge().schedule.checkConflict({ startAt: s, endAt: e }), [] as Array<{ id: string; title: string }>)
  conflicts.value = rows.map((r) => '与「' + r.title + '」时间冲突')
}

async function save() {
  if (!form.value.title.trim()) { message.warning('请填写标题'); return }
  const s = form.value.startAt
  const e = form.value.endAt
  if (!s || !e || e <= s) { message.warning('请选择正确的开始与结束时间'); return }
  try {
    const payload = {
      title: form.value.title.trim(),
      startAt: s,
      endAt: e,
      calendarId: form.value.calendarId,
      place: form.value.place || null,
      remindMin: form.value.remindMin,
      recurRule: form.value.recurRule === 'none' ? null : form.value.recurRule,
      note: form.value.note || null
    }
    if (editingId.value) {
      await call(() => bridge().schedule.update(plain({ id: editingId.value as string, ...payload })))
      message.success('日程已更新')
    } else {
      await call(() => bridge().schedule.create(plain(payload)))
      message.success('日程已创建')
    }
    showModal.value = false
    editingId.value = null
    await load()
  } catch (err) { message.error((err as Error).message) }
}

function removeEvent(e: ScheduleRow) {
  dialog.warning({
    title: '删除日程',
    content: '确定删除「' + e.title + '」？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await call(() => bridge().schedule.remove(e.id))
      showDrawer.value = false
      await load()
      message.success('已删除')
    }
  })
}

async function saveNote(v: string) {
  const cur = selected.value
  if (!cur) return
  await call(() => bridge().schedule.update({ id: cur.id, note: v }))
  message.success('备注已保存')
}

async function exportICS() {
  const r = monthRange(panelYear.value, panelMonth.value)
  const text = await call(() => bridge().schedule.exportICS({ from: r.from, to: r.to }), '')
  if (!text) { message.warning('无数据可导出'); return }
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'schedule-' + panelYear.value + '-' + panelMonth.value + '.ics'
  a.click()
  URL.revokeObjectURL(a.href)
  message.success('已导出 ICS')
}

/**
 * 日程 → 待办：同步标题、截止时间、清单、备注、关联日程 ID。
 * 截止时间取日程开始时间，这样待办列表里能按「今天/本周」正确归类。
 */
async function toTodo() {
  const cur = selected.value
  if (!cur) return

  const startAt = cur.instanceAt ?? cur.startAt
  // 日程分类映射到同名待办清单；没有同名清单就落到默认清单
  const matchedList = store.todoLists.find((l) => l.name === cur.calendarName)

  try {
    await store.addTodo(cur.title, {
      listId: matchedList ? matchedList.id : null,
      priority: '中',
      dueAt: startAt,
      remindAt: cur.remindMin > 0 ? startAt - cur.remindMin * 60000 : null,
      note: cur.note || null,
      scheduleId: cur.id,
      sourceType: 'schedule',
      sourceRef: cur.id
    })
    message.success('已转为待办，截止时间同步为 ' + fmtTime(startAt))
    showDrawer.value = false
  } catch (e) {
    log.exception('schedule.toTodo', e)
    message.error('转换失败：' + (e as Error).message)
  }
}

const calOptions = computed(() => calendars.value.map((c) => ({ label: c.name, value: c.id })))
const remindOptions = [5, 10, 30].map((m) => ({ label: '提前 ' + m + ' 分钟', value: m }))
const recurOptions = [
  { label: '不重复', value: 'none' },
  { label: '每天', value: 'daily' },
  { label: '每周', value: 'weekly' },
  { label: '每月', value: 'monthly' }
]
function recurText(r: string | null) {
  if (r === 'daily') return '每天'
  if (r === 'weekly') return '每周'
  if (r === 'monthly') return '每月'
  return '不重复'
}

const dayList = computed(() => eventsOfDay(new Date(calValue.value).getFullYear(), new Date(calValue.value).getMonth() + 1, new Date(calValue.value).getDate()))

onMounted(async () => {
  await load()
  await applyFocus(focusKey.value, focusAtQuery.value)
})
// 同一页面里再从仪表盘点另一条日程时重新定位
watch([focusKey, focusAtQuery], () => { void applyFocus(focusKey.value, focusAtQuery.value) })
</script>

<template>
  <Shell>
    <template #subtitle>{{ monthLabel }} · 本月 {{ monthEvents.length }} 个日程</template>
    <template #actions>
      <n-button size="small" @click="goToday">今天</n-button>
      <n-button size="small" @click="exportICS">导出 ICS</n-button>
      <n-button size="small" type="primary" @click="openCreate">新建日程</n-button>
    </template>

    <n-alert v-if="hint" :type="hint.type" closable :bordered="false" class="focus-hint" @close="dismissHint">
      <div class="focus-hint-row">
        <span>{{ hint.text }}</span>
        <n-button text size="tiny" @click="dismissHint">清除定位</n-button>
      </div>
    </n-alert>

    <div class="sc-month-layout">
      <section class="card sc-month-main">
        <n-calendar
          v-model:value="calValue"
          :first-day-of-week="1"
          @panel-change="onPanelChange"
          @update:value="onPick"
        >
          <template #header="{ year, month }">
            <div style="font-size:14px;font-weight:600">{{ year }} 年 {{ month }} 月</div>
          </template>
          <template #default="{ year, month, date }">
            <div style="display:flex;flex-direction:column;gap:2px;height:100%;overflow:hidden" @click="calValue = new Date(year, month - 1, date).getTime()">
              <div
                v-for="e in eventsOfDay(year, month, date).slice(0, 3)"
                :key="e.id + '-' + (e.instanceAt ?? e.startAt)"
                class="sc-month-chip"
                :class="[colorOf(e), { 'focus-flash': isFocused(e) }]"
                :data-focus-id="e.id"
                :data-focus-at="String(e.instanceAt ?? e.startAt)"
                @click.stop="openEvent(e)"
              >
                <b>{{ fmtTime(e.instanceAt ?? e.startAt) }} {{ e.title }}</b>
              </div>
              <span v-if="eventsOfDay(year, month, date).length > 3" style="font-size:10px;opacity:.7">+{{ eventsOfDay(year, month, date).length - 3 }} 更多</span>
            </div>
          </template>
        </n-calendar>
      </section>

      <aside class="sc-month-side">
        <div class="card" style="padding:14px">
          <div class="card-head" style="margin-bottom:8px"><div class="card-title">我的日历</div></div>
          <label v-for="c in calendars" :key="c.id" class="cal-check" style="display:flex;align-items:center;gap:8px;min-height:28px">
            <n-checkbox :checked="c.visible" @update:checked="toggleCal(c)" />
            <span class="dotc" :style="{ background: c.color }"></span>
            <span style="font-size:13px">{{ c.name }}</span>
          </label>
        </div>

        <div class="card" style="padding:14px">
          <div class="card-head" style="margin-bottom:8px"><div class="card-title">当日日程</div><n-tag size="tiny">{{ dayList.length }}</n-tag></div>
          <div
            v-for="e in dayList"
            :key="e.id"
            class="sc-side-row"
            :class="{ 'focus-flash': isFocused(e) }"
            :data-focus-id="e.id"
            :data-focus-at="String(e.instanceAt ?? e.startAt)"
            @click="openEvent(e)"
          >
            <span class="dotc" :style="{ background: e.calendarColor || 'var(--primary)', marginTop: '6px' }"></span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ e.title }}</div>
              <div style="font-size:11px;color:var(--muted)">{{ fmtRange(e) }}{{ e.place ? ' · ' + e.place : '' }}</div>
            </div>
          </div>
          <n-empty v-if="!dayList.length" size="small" description="当日暂无日程" style="padding:16px 0" />
        </div>
      </aside>
    </div>

    <n-drawer v-model:show="showDrawer" :width="360" placement="right">
      <n-drawer-content v-if="selected" :title="selected.title" closable :native-scrollbar="false">
        <div>
          <div class="field"><span class="k">时间</span><span class="v">{{ fmtDateFull(selected) }} {{ fmtRange(selected) }}</span></div>
          <div class="field"><span class="k">地点</span><span class="v">{{ selected.place || '—' }}</span></div>
          <div class="field"><span class="k">日历分类</span><span class="v"><span class="dotc" :style="{ background: selected.calendarColor || '#2563eb' }"></span>{{ selected.calendarName || '—' }}</span></div>
          <div class="field"><span class="k">提醒</span><span class="v">提前 {{ selected.remindMin }} 分钟</span></div>
          <div class="field"><span class="k">重复</span><span class="v">{{ recurText(selected.recurRule) }}</span></div>
          <div style="margin-top:14px">
            <div class="k" style="font-size:12px;margin-bottom:6px">备注</div>
            <n-input type="textarea" :value="selected.note || ''" :autosize="{ minRows: 3 }" placeholder="补充说明" @blur="saveNote(($event.target as HTMLTextAreaElement).value)" />
          </div>
        </div>
        <template #footer>
          <n-space style="width:100%">
            <n-button type="primary" size="small" @click="$router.push('/pomodoro')">开始专注</n-button>
            <n-button size="small" @click="selected && openEdit(selected)">编辑</n-button>
            <n-button size="small" @click="toTodo">转为待办</n-button>
            <n-button size="small" type="error" quaternary @click="removeEvent(selected)">删除</n-button>
          </n-space>
        </template>
      </n-drawer-content>
    </n-drawer>

    <n-modal v-model:show="showModal" preset="card" :title="editingId ? '编辑日程' : '新建日程'" style="width:520px">
      <div>
        <n-form label-placement="left" label-width="56" size="small">
          <n-form-item label="标题"><n-input v-model:value="form.title" placeholder="添加标题" /></n-form-item>
          <n-form-item label="开始">
            <n-date-picker v-model:value="form.startAt" type="datetime" clearable style="width:100%" placeholder="选择开始时间" @update:value="recheck" />
          </n-form-item>
          <n-form-item label="结束">
            <n-date-picker v-model:value="form.endAt" type="datetime" clearable style="width:100%" placeholder="选择结束时间" @update:value="recheck" />
          </n-form-item>
          <n-form-item label="地点"><n-input v-model:value="form.place" placeholder="会议室 / 线上" /></n-form-item>
          <n-form-item label="日历"><n-select v-model:value="form.calendarId" :options="calOptions" placeholder="选择分类" /></n-form-item>
          <n-form-item label="提醒"><n-select v-model:value="form.remindMin" :options="remindOptions" /></n-form-item>
          <n-form-item label="重复"><n-select v-model:value="form.recurRule" :options="recurOptions" /></n-form-item>
          <n-form-item label="备注"><n-input v-model:value="form.note" type="textarea" placeholder="补充说明" /></n-form-item>
        </n-form>
        <div v-if="conflicts.length" style="padding:8px 12px;border-radius:8px;background:var(--accent-soft);border:1px solid var(--accent-border);font-size:12px;color:var(--accent)">{{ conflicts.join('；') }}</div>
      </div>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <n-button size="small" @click="showModal = false; editingId = null">取消</n-button>
          <n-button size="small" type="primary" @click="save">保存</n-button>
        </div>
      </template>
    </n-modal>
  </Shell>
</template>