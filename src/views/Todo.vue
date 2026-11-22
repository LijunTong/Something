<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import {
  useMessage, useDialog,
  NButton, NInput, NSelect, NCheckbox, NEmpty, NSpin, NAlert,
  NModal, NForm, NFormItem, NTag, NDrawer, NDrawerContent, NSpace, NTooltip, NDatePicker, NText
} from 'naive-ui'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import Shell from '@/components/Shell.vue'
import type { TodoRow, ScheduleRow } from '@/types/api'
import { call, bridge, plain } from '@/lib/ipc'
import { isTypingTarget, matchesCombo } from '@/lib/shortcut'
import { log } from '@/lib/logger'
import { useFocusQuery } from '@/composables/useFocusQuery'
import '@/styles/todo.css'

const store = useAppStore()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()

type SmartFilter = '今天' | '本周' | '已完成'
// 默认选中「今天」，与原型一致；收件箱选项已去掉
const smart = ref<SmartFilter | null>('今天')
const activeListId = ref<string | null>(null)
const filter = ref<'全部' | '未完成' | '高优先级' | '有截止时间'>('全部')
const selectedId = ref<string | null>(null)
const quickTitle = ref('')
const showModal = ref(false)
const showDetail = ref(false)
const loading = ref(false)
// 深链定位：仪表盘点某条待办 → /todo?focus=<id>，落地后打开详情并把该行滚到中间
const {
  focusId: focusKey,
  hint: hint,
  highlight: highlightId,
  locate: locateFocus,
  miss: missFocus,
  dismiss: dismissHint
} = useFocusQuery()

interface Draft {
  title: string
  listId: string | null
  priority: string
  dueAt: number | null
  remindText: string
  labelsText: string
  note: string
}
/** 新建默认今天：截止时间给到今天 23:59。这里内联算日期，不能调用 startOfToday()——
    它声明在下面且本函数在模块初始化时就被调用，会撞上暂时性死区。 */
const blankDraft = (): Draft => {
  const dayEnd = new Date()
  dayEnd.setHours(23, 59, 59, 0)
  return { title: '', listId: null, priority: '中', dueAt: dayEnd.getTime(), remindText: '10', labelsText: '', note: '' }
}
const draft = ref<Draft>(blankDraft())
/** 为空表示新建；有值表示正在编辑这条待办 */
const editingId = ref<string | null>(null)

const priorityOptions = ['高', '中', '低'].map((x) => ({ label: x, value: x }))
const remindOptions = [
  { label: '不提醒', value: '0' },
  { label: '提前 5 分钟', value: '5' },
  { label: '提前 10 分钟', value: '10' },
  { label: '提前 30 分钟', value: '30' },
  { label: '提前 1 小时', value: '60' }
]
const listOptions = computed(() => store.todoLists.map((l) => ({ label: l.name, value: l.id })))
const filters: Array<'全部' | '未完成' | '高优先级' | '有截止时间'> = ['全部', '未完成', '高优先级', '有截止时间']

/** 快捷键：N 新建任务（组合键可在设置里改） */
function onShortcut(e: KeyboardEvent) {
  if (isTypingTarget(e.target)) return
  const map = store.settings?.shortcuts
  if (showModal.value || showDetail.value || showSubtaskModal.value) return
  if (matchesCombo(e, map?.newTodo || 'N')) {
    e.preventDefault()
    draft.value = blankDraft()
    showModal.value = true
    return
  }
}
onMounted(() => window.addEventListener('keydown', onShortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', onShortcut))

const now = () => Date.now()
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
const endOfWeek = () => {
  const d = new Date(); d.setHours(23, 59, 59, 999)
  const add = (7 - ((d.getDay() + 6) % 7) - 1) * 86400000
  return d.getTime() + add
}

/** 智能清单 + 清单 + 筛选 三层叠加后的结果 */
const visible = computed<TodoRow[]>(() => {
  let rows = store.todos
  if (activeListId.value) rows = rows.filter((t) => t.listId === activeListId.value)
  if (smart.value === '今天') rows = rows.filter((t) => t.dueAt !== null && t.dueAt < startOfToday() + 86400000)
  else if (smart.value === '本周') rows = rows.filter((t) => t.dueAt !== null && t.dueAt <= endOfWeek())
  else if (smart.value === '已完成') rows = rows.filter((t) => t.status === '已完成')
  if (filter.value === '未完成') rows = rows.filter((t) => t.status !== '已完成')
  if (filter.value === '高优先级') rows = rows.filter((t) => t.priority === '高')
  if (filter.value === '有截止时间') rows = rows.filter((t) => t.dueAt !== null)
  return rows
})

const selected = computed(() => store.todos.find((t) => t.id === selectedId.value) ?? null)
const todayCount = computed(() => store.todos.filter((t) => t.status !== '已完成' && t.dueAt !== null && t.dueAt < startOfToday() + 86400000).length)
const weekCount = computed(() => store.todos.filter((t) => t.status !== '已完成' && t.dueAt !== null && t.dueAt <= endOfWeek()).length)
const doneCount = computed(() => store.todos.filter((t) => t.status === '已完成').length)
function listCount(id: string) {
  return store.todos.filter((t) => t.listId === id && t.status !== '已完成').length
}

function fmtDue(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date()
  const same = d.toDateString() === today.toDateString()
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  if (same) return '今天 ' + hm
  const diff = Math.round((new Date(ts).setHours(0,0,0,0) - new Date(today).setHours(0,0,0,0)) / 86400000)
  if (diff === -1) return '昨天 ' + hm
  if (diff > 0 && diff < 7) return '周' + ['日','一','二','三','四','五','六'][d.getDay()] + ' ' + hm
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
}
const isOverdue = (t: TodoRow) => !!t.dueAt && t.dueAt < now() && t.status !== '已完成'

/** 提醒时间转成「提前 X 分钟」这类可读文案 */
function remindText(ts: number | null): string {
  if (!ts) return '不提醒'
  const t = selected.value
  if (t?.dueAt) {
    const diff = Math.round((t.dueAt - ts) / 60000)
    if (diff > 0) return '提前 ' + diff + ' 分钟'
  }
  return fmtDue(ts)
}

/** 关联日程标题：打开详情时按 scheduleId 现查一次 */
const scheduleTitles = ref<Record<string, string>>({})

async function withLoading<T>(fn: () => Promise<T>): Promise<T | undefined> {
  loading.value = true
  try { return await fn() }
  catch (e) { log.exception('todo', e); message.error((e as Error).message); return undefined }
  finally { loading.value = false }
}

async function quickAdd() {
  const title = quickTitle.value.trim()
  if (!title) return
  await withLoading(async () => {
    await store.addTodo(title, {
      listId: activeListId.value,
      dueAt: startOfToday() + 86399000
    })
    quickTitle.value = ''
    message.success('任务已创建')
  })
}

async function onToggle(t: TodoRow) {
  await withLoading(async () => {
    await store.toggleTodo(t.id)
    message.success(t.status === '已完成' ? '已恢复' : '已完成')
  })
}

async function loadScheduleTitle(id: string | null) {
  if (!id || scheduleTitles.value[id]) return
  const rows = await call(() => bridge().schedule.range({ from: 0, to: 4102444800000 }), [] as ScheduleRow[])
  const hit = rows.find((s) => s.id === id)
  if (hit) scheduleTitles.value = { ...scheduleTitles.value, [id]: hit.title }
}

/** 已完成的任务只能查看：编辑、转日程、开始专注、删除都关掉 */
const readOnly = computed(() => selected.value?.status === '已完成')

function openTask(t: TodoRow) {
  selectedId.value = t.id
  showDetail.value = true
  void loadScheduleTitle(t.scheduleId)
}

/** 深链定位：先放开展清单一层筛选，再打开详情抽屉并滚动高亮目标行。 */
async function applyFocus(id: string): Promise<void> {
  const key = String(id || '')
  if (!key) return
  const t = store.todos.find((x) => x.id === key)
  if (!t) { missFocus(); return }
  // 目标可能被当前智能清单/清单挡住，深链时一律回到「全部清单 + 全部筛选」
  smart.value = null
  activeListId.value = null
  filter.value = '全部'
  openTask(t)
  const due = t.dueAt ? ' · 截止 ' + fmtDue(t.dueAt) : ''
  await locateFocus(key, '来自仪表盘：' + t.title + due)
}

function linkedScheduleTitle(id: string | null): string | null {
  if (!id) return null
  return scheduleTitles.value[id] ?? null
}

async function onToggleSubtask(id: string) {
  await withLoading(() => store.toggleSubtask(id))
}

// Electron 30+ 已移除 window.prompt，调用会抛 Illegal invocation，
// 这里改用 Naive UI 的输入弹窗。
const showSubtaskModal = ref(false)
const subtaskTitle = ref('')

function onAddSubtask() {
  if (!selected.value) return
  subtaskTitle.value = ''
  showSubtaskModal.value = true
}

async function saveSubtask() {
  const t = selected.value
  const title = subtaskTitle.value.trim()
  if (!t || !title) { message.warning('请输入子任务标题'); return }
  await withLoading(async () => {
    await store.addSubtask(t.id, title)
    showSubtaskModal.value = false
    message.success('子任务已添加')
  })
}

async function saveNote(v: string) {
  const t = selected.value
  if (!t) return
  await withLoading(async () => {
    await store.updateTodo({ id: t.id, note: v })
    message.success('备注已保存')
  })
}

/** 详情抽屉 → 编辑：把当前待办填进草稿，复用新建任务的表单 */
function openEdit(t: TodoRow) {
  const remind = t.remindAt && t.dueAt ? String(Math.max(0, Math.round((t.dueAt - t.remindAt) / 60000))) : '0'
  editingId.value = t.id
  draft.value = {
    title: t.title,
    listId: t.listId,
    priority: t.priority,
    dueAt: t.dueAt,
    remindText: remindOptions.some((o) => o.value === remind) ? remind : '10',
    labelsText: (t.labels || []).join(', '),
    note: t.note || ''
  }
  showModal.value = true
}

async function saveDraft() {
  if (!draft.value.title.trim()) { message.warning('请填写任务标题'); return }
  if (editingId.value) {
    await withLoading(async () => {
      const dueAt = draft.value.dueAt
      const remindMin = Number(draft.value.remindText)
      const id = editingId.value as string
      await store.updateTodo({
        id,
        title: draft.value.title.trim(),
        listId: draft.value.listId,
        priority: draft.value.priority,
        dueAt,
        remindAt: dueAt && remindMin > 0 ? dueAt - remindMin * 60000 : null,
        labels: draft.value.labelsText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
        note: draft.value.note || null
      })
      showModal.value = false
      editingId.value = null
      draft.value = blankDraft()
      message.success('已保存')
    })
    return
  }
  await withLoading(async () => {
    const dueAt = draft.value.dueAt
    const remindMin = Number(draft.value.remindText)
    await store.addTodo(draft.value.title.trim(), {
      listId: draft.value.listId,
      priority: draft.value.priority,
      dueAt,
      remindAt: dueAt && remindMin > 0 ? dueAt - remindMin * 60000 : null,
      labels: draft.value.labelsText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
      note: draft.value.note || null
    })
    showModal.value = false
    draft.value = blankDraft()
    message.success('任务已创建')
  })
}

function confirmDelete(t: TodoRow) {
  dialog.warning({
    title: '删除任务',
    content: '确定删除「' + t.title + '」？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await withLoading(async () => {
        await store.removeTodo(t.id)
        showDetail.value = false
        selectedId.value = null
        message.success('已删除')
      })
    }
  })
}

/**
 * 待办 → 日程：同步标题、起止时间、分类、备注、关联待办 ID。
 * 有截止时间则以它为开始、默认 1 小时；没有则排在今天 9:30。
 */
async function toSchedule() {
  const t = selected.value
  if (!t) return

  // 没有截止时间就排到下一个整点半，避免落在一个已经过去的时间点
  const startAt = t.dueAt ?? Math.ceil(Date.now() / 1800000) * 1800000
  const endAt = startAt + 3600000
  // 待办清单映射到同名日程分类；对不上就落到第一个分类，避免产生无分类事件
  const cals = await call(() => bridge().schedule.calendars(), [] as Array<{ id: string; name: string }>)
  const matched = cals.find((c) => c.name === t.listName) || cals[0]

  try {
    const created = await call(() => bridge().schedule.create(plain({
      title: t.title,
      startAt,
      endAt,
      calendarId: matched ? matched.id : null,
      place: null,
      remindMin: 10,
      recurRule: null,
      note: t.note || null
    })), null as ScheduleRow | null)
    await store.updateTodo({ id: t.id, scheduleId: created ? created.id : null })
    message.success('已转为日程，开始时间 ' + fmtDue(startAt))
    showDetail.value = false
    if (created) void router.push('/schedule')
  } catch (e) {
    log.exception('todo.toSchedule', e)
    message.error('转换失败：' + (e as Error).message)
  }
}

/** 开始专注：把这条待办绑到番茄钟；已有专注在计时就不动它 */
async function startFocus() {
  const t = selected.value
  if (!t) return
  const st = await call(() => bridge().pomodoro.state(), null as { phase?: string } | null)
  if (st && st.phase && st.phase !== 'idle') {
    message.info('已有专注在计时，先结束它再开始新的')
    return
  }
  try {
    await call(() => bridge().pomodoro.start(plain({ taskId: t.id })), null)
    showDetail.value = false
    void router.push('/pomodoro')
  } catch (e) {
    log.exception('todo.startFocus', e)
    message.error('开始专注失败：' + (e as Error).message)
  }
}

// 两种清单可同时选中、叠加筛选；再次点击同一项则取消选中。
function pickSmart(v: SmartFilter) {
  smart.value = smart.value === v ? null : v
}
function pickList(id: string) {
  activeListId.value = activeListId.value === id ? null : id
}
function openCreate() {
  editingId.value = null
  draft.value = blankDraft()
  draft.value.listId = activeListId.value
  showModal.value = true
}

onMounted(async () => {
  // 先等数据到位再定位：列表为空时找不到目标行，会误报「已不存在」
  try { await store.refreshTodos() } catch (e) { log.exception('todo.refresh', e) }
  await applyFocus(focusKey.value)
})

// 同一页面里再从仪表盘点另一条：组件被复用，onMounted 不会再跑
watch(focusKey, (v) => { void applyFocus(String(v || '')) })
</script>

<template>
  <Shell>
    <template #subtitle>今日 {{ todayCount }} 项待完成 · 已完成 {{ doneCount }} 项</template>
    <template #actions>
      <n-button size="small" type="primary" @click="openCreate">新建任务</n-button>
    </template>

    <n-alert v-if="hint" :type="hint.type" closable :bordered="false" class="focus-hint" @close="dismissHint">
      <div class="focus-hint-row">
        <span>{{ hint.text }}</span>
        <n-button text size="tiny" @click="dismissHint">清除定位</n-button>
      </div>
    </n-alert>

    <n-spin :show="loading">
      <div class="td-layout">
        <!-- 左栏：智能清单 + 我的清单 -->
        <aside class="card td-side">
          <div class="td-group">智能清单</div>
          <a class="td-nav" :class="{ on: smart === '今天' }" href="#" @click.prevent="pickSmart('今天')">
            <svg><use href="#i-clock"/></svg><span>今天</span><span>{{ todayCount }}</span>
          </a>
          <a class="td-nav" :class="{ on: smart === '本周' }" href="#" @click.prevent="pickSmart('本周')">
            <svg><use href="#i-cal"/></svg><span>本周</span><span>{{ weekCount }}</span>
          </a>
          <a class="td-nav" :class="{ on: smart === '已完成' }" href="#" @click.prevent="pickSmart('已完成')">
            <svg><use href="#i-check"/></svg><span>已完成</span><span>{{ doneCount }}</span>
          </a>
          <div class="td-group">我的清单</div>
          <a v-for="l in store.todoLists" :key="l.id" class="td-nav" :class="{ on: activeListId === l.id }" href="#" @click.prevent="pickList(l.id)">
            <span class="dotc" :style="{ background: l.color || 'var(--muted-2)' }"></span><span>{{ l.name }}</span><span>{{ listCount(l.id) }}</span>
          </a>
        </aside>

        <!-- 中栏：快速添加 + 筛选 + 任务列表 -->
        <section class="card td-mid">
          <div class="td-quick">
            <n-input v-model:value="quickTitle" placeholder="快速添加任务，回车即可创建" @keyup.enter="quickAdd" />
          </div>

          <div class="td-filters">
            <n-button v-for="f in filters" :key="f" size="tiny" round :type="filter === f ? 'primary' : 'default'" @click="filter = f">{{ f }}</n-button>
          </div>

          <div class="td-list">
            <div
              v-for="t in visible"
              :key="t.id"
              class="td-row"
              :class="{ done: t.status === '已完成', selected: t.id === selectedId, 'focus-flash': highlightId === t.id }"
              :data-focus-id="t.id"
              @click="openTask(t)"
            >
              <div class="td-task">
                <span @click.stop><n-checkbox :checked="t.status === '已完成'" @update:checked="onToggle(t)" /></span>
                <span class="td-title">{{ t.title }}</span>
              </div>
              <span class="td-tags">
                <n-tag v-if="t.priority === '高'" size="tiny" type="warning">高</n-tag>
                <n-tag v-if="t.listName" size="tiny">{{ t.listName }}</n-tag>
              </span>
              <n-tag v-if="isOverdue(t)" size="tiny" type="error">{{ fmtDue(t.dueAt) }}</n-tag>
              <span v-else class="td-due">{{ fmtDue(t.dueAt) }}</span>
            </div>
            <n-empty v-if="!visible.length" class="td-empty" description="这里还没有任务" />
          </div>
        </section>
      </div>
    </n-spin>

    <!-- 详情抽屉 -->
    <n-drawer v-model:show="showDetail" :width="380" placement="right">
      <n-drawer-content v-if="selected" :title="selected.title" closable :native-scrollbar="false">
        <template #header>
          <div style="display:flex;align-items:center;gap:8px;width:100%">
            <n-checkbox :checked="selected.status === '已完成'" @update:checked="onToggle(selected)" />
            <span style="flex:1">{{ selected.title }}</span>
          </div>
        </template>
        <div>
          <div class="field"><span class="k">清单</span><span class="v">{{ selected.listName || '—' }}</span></div>
          <div class="field"><span class="k">优先级</span><span class="v"><n-tag size="tiny" :type="selected.priority === '高' ? 'warning' : 'default'">{{ selected.priority }}</n-tag></span></div>
          <div class="field"><span class="k">截止时间</span><span class="v">{{ fmtDue(selected.dueAt) || '无' }}</span></div>
          <div class="field"><span class="k">提醒</span><span class="v">{{ remindText(selected.remindAt) }}</span></div>
          <div class="field">
            <span class="k">标签</span>
            <span class="v">
              <n-tag v-for="lb in selected.labels" :key="lb" size="tiny" style="margin-left:4px">{{ lb }}</n-tag>
              <span v-if="!selected.labels.length" class="muted">无</span>
            </span>
          </div>
          <div class="field"><span class="k">关联日程</span><span class="v">{{ linkedScheduleTitle(selected.scheduleId) || '无' }}</span></div>
          <div class="field"><span class="k">已投入专注</span><span class="v">{{ Math.round(selected.focusSeconds / 60) }} 分钟</span></div>
          <div class="td-subtitle">子任务 {{ selected.subtasks.filter((s) => s.done).length }}/{{ selected.subtasks.length }}</div>
          <div v-for="s in selected.subtasks" :key="s.id" class="td-sub">
            <n-checkbox :checked="s.done" @update:checked="onToggleSubtask(s.id)" />
            <span>{{ s.title }}</span>
          </div>
          <n-button size="tiny" quaternary :disabled="readOnly" @click="onAddSubtask">+ 添加子任务</n-button>
          <div class="td-note">
            备注
            <n-input type="textarea" :value="selected.note || ''" :autosize="{ minRows: 3 }" :disabled="readOnly" placeholder="补充说明" @blur="saveNote(($event.target as HTMLTextAreaElement).value)" />
          </div>
        </div>
        <template #footer>
          <div class="td-actions">
            <n-text v-if="readOnly" depth="3">已完成的任务只能查看，取消勾选后可继续操作</n-text>
            <n-space style="width:100%">
              <n-button type="primary" size="small" :disabled="readOnly" @click="openEdit(selected)">编辑</n-button>
              <n-button size="small" :disabled="readOnly" @click="startFocus">开始专注</n-button>
              <n-button size="small" :disabled="readOnly" @click="toSchedule">转为日程</n-button>
              <n-button size="small" type="error" quaternary :disabled="readOnly" @click="confirmDelete(selected)">删除</n-button>
            </n-space>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 新建子任务 -->
    <n-modal v-model:show="showSubtaskModal" preset="card" title="新建子任务" style="width:400px">
      <n-form label-placement="left" label-width="56" size="small">
        <n-form-item label="标题">
          <n-input v-model:value="subtaskTitle" placeholder="子任务标题" @keyup.enter="saveSubtask" />
        </n-form-item>
      </n-form>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <n-button size="small" @click="showSubtaskModal = false">取消</n-button>
          <n-button size="small" type="primary" @click="saveSubtask">保存</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 新建任务 -->
    <n-modal v-model:show="showModal" preset="card" :title="editingId ? '编辑任务' : '新建任务'" style="width:480px">
      <n-form label-placement="left" label-width="64" size="small">
        <n-form-item label="标题"><n-input v-model:value="draft.title" placeholder="任务标题" /></n-form-item>
        <n-form-item label="清单"><n-select v-model:value="draft.listId" :options="listOptions" clearable placeholder="选择清单" /></n-form-item>
        <n-form-item label="优先级"><n-select v-model:value="draft.priority" :options="priorityOptions" /></n-form-item>
        <n-form-item label="截止">
          <n-date-picker v-model:value="draft.dueAt" type="datetime" clearable style="width:100%" placeholder="选择截止日期与时间" />
        </n-form-item>
        <n-form-item label="提醒">
          <n-select v-model:value="draft.remindText" :options="remindOptions" />
        </n-form-item>
        <n-form-item label="标签"><n-input v-model:value="draft.labelsText" placeholder="工作, 紧急（逗号分隔）" /></n-form-item>
        <n-form-item label="备注"><n-input v-model:value="draft.note" type="textarea" placeholder="补充说明" /></n-form-item>
      </n-form>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <n-button size="small" @click="showModal = false">取消</n-button>
          <n-button size="small" type="primary" @click="saveDraft">保存</n-button>
        </div>
      </template>
    </n-modal>
  </Shell>
</template>
