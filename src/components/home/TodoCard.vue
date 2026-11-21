<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NCheckbox, NEmpty, NSpin, NButton } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { TodoRow, TodoStats } from '@/types/api'

const router = useRouter()
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

/** 今日待办：无截止时间或截止在今天，优先按截止时间排序 */
const list = computed(() => {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return pending.value
    .filter((t) => !t.dueAt || t.dueAt <= end.getTime())
    .sort((a, b) => (a.dueAt || Number.MAX_SAFE_INTEGER) - (b.dueAt || Number.MAX_SAFE_INTEGER))
    .slice(0, 4)
})

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

onMounted(load)
const refreshTick = useHomeCardRefresh('todo')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-todo">
    <template #header>
      <div class="hc-head">
        <span>今日待办</span>
        <n-tag size="tiny" :type="pending.length ? 'warning' : 'success'">剩余 {{ pending.length }}</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <n-button size="tiny" quaternary @click="router.push('/todo')">+ 添加</n-button>
          <HomeCardMenu module="todo" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty v-if="!list.length" size="small" description="今天没有待办" />
      <label v-for="t in list" :key="t.id" class="hc-todo-item">
        <n-checkbox :checked="false" @update:checked="toggle(t)" />
        <span class="hc-todo-text">
          <strong>{{ t.title }}</strong>
          <small class="hc-muted">
            {{ t.dueAt ? (overdue(t) ? '已逾期 ' : '截止 ') + hhmm(t.dueAt) : '无截止时间' }}
            <template v-if="t.labels.length"> · {{ t.labels.join(' / ') }}</template>
          </small>
        </span>
        <n-tag v-if="t.priority === '高'" size="tiny" type="warning">高</n-tag>
        <n-tag v-else-if="t.priority === '中'" size="tiny">中</n-tag>
        <n-tag v-else size="tiny" type="info">低</n-tag>
      </label>
    </n-spin>

    <template #footer>
      <span class="hc-muted">
        今日剩余 <strong>{{ pending.length }}</strong> 项 · 已完成 <strong>{{ done.length }}</strong> 项
        · 逾期 <strong>{{ stats?.overdue ?? 0 }}</strong> 项
      </span>
    </template>
  </n-card>
</template>