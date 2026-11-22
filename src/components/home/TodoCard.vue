<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NCheckbox, NEmpty, NSpin, NButton, NModal, NForm, NFormItem, NInput, NSelect, NDatePicker, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { triggerHomeRefresh } from '@/composables/useHomeRefresh'
import type { TodoRow, TodoStats, TodoListRow } from '@/types/api'

const router = useRouter()
const message = useMessage()
const rows = ref<TodoRow[]>([])
const stats = ref<TodoStats | null>(null)
const loading = ref(false)

function hhmm(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

const pending = computed(() => rows.value.filter((t) => t.status !== '已完成' && t.status !== '取消'))
const done = computed(() => rows.value.filter((t) => t.status === '已完成'))

/**
 * 今日待办：无截止时间或截止在今天。
 * 计数与列表用同一份 todayList —— 之前标签直接数 pending（含明天以后的），
 * 会出现「只有 1 条却显示 2 条」。
 */
const todayList = computed(() => {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return pending.value
    .filter((t) => !t.dueAt || t.dueAt <= end.getTime())
    .sort((a, b) => (a.dueAt || Number.MAX_SAFE_INTEGER) - (b.dueAt || Number.MAX_SAFE_INTEGER))
})
const todayPending = computed(() => todayList.value.length)
const list = computed(() => todayList.value.slice(0, 4))

function overdue(t: TodoRow): boolean {
  return !!t.dueAt && t.dueAt < Date.now()
}

async function load() {
  if (!hasBridge()) return
  loading.value = true
  try {
    const [list_, s] = await Promise.all([
      call(() => bridge().todo.list({}), [] as TodoRow[]),
      call(() => bridge().todo.stats(), null as unknown as TodoStats)
    ])
    rows.value = list_
    stats.value = s
  } catch (e) {
    log.exception('home.todo', e)
  } finally {
    loading.value = false
  }
}

async function toggle(t: TodoRow) {
  try {
    await call(() => bridge().todo.toggle(t.id))
    await load()
  } catch (e) {
    log.exception('home.todo.toggle', e)
  }
}

/** 新增待办：入口在卡片菜单里，弹窗在本页填写保存，不跳待办页 */
const showCreate = ref(false)
const saving = ref(false)
const lists = ref<TodoListRow[]>([])
const form = ref({ title: '', priority: '中', listId: null as string | null, dueAt: null as number | null, note: '' })

/** 截止默认给今天 23:59：卡片上新增的多半是「今天要做的事」，改日期比补日期省事 */
function blankForm() {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return { title: '', priority: '中', listId: null as string | null, dueAt: end.getTime() as number | null, note: '' }
}
async function openCreate() {
  try {
    form.value = blankForm()
    showCreate.value = true
  } catch (e) {
    message.error('打开新增待办失败：' + ((e as Error).message || '未知错误'))
    return
  }
  await nextTick()
  titleInput.value?.focus()
  if (!hasBridge() || lists.value.length) return
  try {
    lists.value = await call(() => bridge().todo.lists(), [] as TodoListRow[])
  } catch (e) {
    log.exception('home.todo.lists', e)
  }
}
function onMenu(key: string) {
  if (key === 'create') void openCreate()
}
async function submitCreate() {
  const title = form.value.title.trim()
  if (!title) { message.warning('先写个待办标题'); return }
  saving.value = true
  try {
    await call(() => bridge().todo.create({
      title,
      priority: form.value.priority,
      listId: form.value.listId,
      dueAt: form.value.dueAt,
      note: form.value.note
    }))
    message.success('已添加到待办')
    showCreate.value = false
    await load()
    triggerHomeRefresh('todo')
  } catch (e) {
    message.error('添加失败：' + ((e as Error).message || '未知错误'))
  } finally {
    saving.value = false
  }
}
const listOptions = computed(() => lists.value.map((l) => ({ label: l.name, value: l.id })))
/** 弹窗一打开就把光标放进标题，避免出现「点了没反应」的错觉 */
const titleInput = ref<{ focus: () => void } | null>(null)
function fmtFull(ts: number | null): string {
  if (!ts) return '未设置'
  const d = new Date(ts)
  const p = (v: number) => String(v).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

onMounted(load)
const refreshTick = useHomeCardRefresh('todo')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-todo">
    <template #header>
      <div class="hc-head">
        <!-- 只有标题文字进待办页，卡片其它区域不跳转 -->
        <n-button text size="small" @click="router.push('/todo')">今日待办</n-button>
        <span class="hc-status"><i class="hc-dot" :class="todayPending ? 'is-warn' : 'is-ok'" />剩余 {{ todayPending }}</span>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <HomeCardMenu module="todo" :actions="[{ label: '新增待办', key: 'create' }]" @action="onMenu" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty v-if="!list.length" size="small" description="今天没有待办" />
      <div v-for="t in list" :key="t.id" class="hc-todo-item">
        <n-checkbox :checked="false" @update:checked="toggle(t)" />
        <!-- 点文字进待办页（点复选框仍是勾选，不抢事件） -->
        <span
          class="hc-todo-text hc-row-link"
          role="button"
          tabindex="0"
          @click="router.push({ path: '/todo', query: { focus: t.id } })"
          @keydown.enter="router.push({ path: '/todo', query: { focus: t.id } })"
        >
          <strong>{{ t.title }}</strong>
          <small class="hc-muted">
            {{ t.dueAt ? (overdue(t) ? '已逾期 ' : '截止 ') + hhmm(t.dueAt) : '无截止时间' }}
            <template v-if="t.labels.length"> · {{ t.labels.join(' / ') }}</template>
          </small>
        </span>
        <span class="hc-status" :title="'优先级：' + t.priority">
          <i class="hc-dot" :class="t.priority === '高' ? 'is-warn' : t.priority === '中' ? 'is-info' : ''" />{{ t.priority }}
        </span>
      </div>
    </n-spin>

    <template #footer>
      <span class="hc-muted">
        今日剩余 <strong>{{ todayPending }}</strong> 项 · 已完成 <strong>{{ done.length }}</strong> 项
        · 逾期 <strong>{{ stats?.overdue ?? 0 }}</strong> 项
      </span>
    </template>
  </n-card>

  <n-modal v-model:show="showCreate" to="body" preset="card" style="width:460px" title="新增待办">
    <n-form label-placement="left" :label-width="60">
      <n-form-item label="标题">
        <n-input ref="titleInput" v-model:value="form.title" placeholder="要做什么？" @keydown.enter="submitCreate" />
      </n-form-item>
      <n-form-item label="清单">
        <n-select v-model:value="form.listId" :options="listOptions" placeholder="默认清单" clearable />
      </n-form-item>
      <n-form-item label="优先级">
        <n-select
          v-model:value="form.priority"
          :options="[{ label: '高', value: '高' }, { label: '中', value: '中' }, { label: '低', value: '低' }]"
        />
      </n-form-item>
      <n-form-item label="截止">
        <n-date-picker v-model:value="form.dueAt" type="datetime" clearable style="width:100%" />
      </n-form-item>
      <n-form-item label="备注">
        <n-input v-model:value="form.note" type="textarea" :rows="2" placeholder="可选" />
      </n-form-item>
    </n-form>
    <template #footer>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <n-button size="small" @click="showCreate = false">取消</n-button>
        <n-button size="small" type="primary" :loading="saving" @click="submitCreate">保存</n-button>
      </div>
    </template>
  </n-modal>
</template>