<script setup lang="ts">
import { homeRefreshToken } from '@/composables/useHomeRefresh'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NProgress, NButton, NEmpty, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { PomodoroConfig, PomodoroState, PomodoroStats, TodoRow } from '@/types/api'

const router = useRouter()
const message = useMessage()

const state = ref<PomodoroState | null>(null)
const stats = ref<PomodoroStats | null>(null)
const config = ref<PomodoroConfig | null>(null)
const todos = ref<TodoRow[]>([])
const remain = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

function dayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

const phaseText = computed(() => {
  const p = state.value?.phase
  if (p === 'running') return '专注中 · 第 ' + (state.value?.round ?? 1) + ' 轮'
  if (p === 'paused') return '已暂停'
  if (p === 'break') return '休息中'
  return '未开始'
})
const boundTask = computed(() => {
  const id = state.value?.taskId
  if (!id) return null
  return todos.value.find((t) => t.id === id) || null
})
const plannedSec = computed(() => (state.value?.plannedSec || (config.value?.focusMin ?? 25) * 60))
const pct = computed(() => {
  // 圆环表达「已用时间」：待开始时 remain=planned → 0%，随时间推进到 100%，而不是一开始就满圈。
  const total = plannedSec.value || 1500
  const left = Math.max(0, Math.min(total, remain.value || total))
  return Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)))
})
const goal = computed(() => config.value?.goal ?? 4)
const doneCount = computed(() => stats.value?.count ?? 0)

async function load() {
  if (!hasBridge()) return
  try {
    const [st, s, c, t] = await Promise.all([
      call(() => bridge().pomodoro.state(), null as unknown as PomodoroState),
      call(() => bridge().pomodoro.stats({ since: dayStart() }), null as unknown as PomodoroStats),
      call(() => bridge().pomodoro.config(), null as unknown as PomodoroConfig),
      call(() => bridge().todo.list({ onlyPending: true }), [] as TodoRow[])
    ])
    if (st) { state.value = st; remain.value = st.remainSec }
    stats.value = s
    config.value = c
    todos.value = t
  } catch (e) {
    log.exception('home.pomodoro', e)
  }
}

async function start() {
  try {
    const st = await call(() => bridge().pomodoro.start({ minutes: config.value?.focusMin ?? 25 }), null as unknown as PomodoroState)
    if (st) { state.value = st; remain.value = st.remainSec }
  } catch (e) {
    log.exception('home.pomodoro.start', e)
    message.error('开始专注失败：' + ((e as Error).message || '未知错误'))
  }
}

async function pause() {
  try {
    const st = await call(() => bridge().pomodoro.pause(), null as unknown as PomodoroState)
    if (st) { state.value = st; remain.value = st.remainSec }
  } catch (e) {
    log.exception('home.pomodoro.pause', e)
  }
}

async function resume() {
  try {
    const st = await call(() => bridge().pomodoro.resume(), null as unknown as PomodoroState)
    if (st) { state.value = st; remain.value = st.remainSec }
  } catch (e) {
    log.exception('home.pomodoro.resume', e)
  }
}

function tick() {
  const st = state.value
  if (!st || st.phase !== 'running') return
  remain.value = Math.max(0, remain.value - 1)
  if (remain.value === 0) { void load() }
}

watch(homeRefreshToken, () => { void load() })

onMounted(async () => {
  await load()
  timer = setInterval(tick, 1000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-pomodoro">
    <template #header>
      <div class="hc-head">
        <span>番茄钟</span>
        <n-tag size="tiny" :type="state?.phase === 'running' ? 'success' : 'default'">{{ phaseText }}</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <n-button size="tiny" quaternary @click="router.push('/pomodoro')">时长设置</n-button>
          <HomeCardMenu module="pomodoro" />
        </div>
      </template>

    <div class="hc-dial">
      <n-progress
        type="circle"
        :percentage="pct"
        :stroke-width="8"
        :show-indicator="false"
        class="hc-dial-ring"
      />
      <div class="hc-dial-text">
        <strong>{{ mmss(remain || plannedSec) }}</strong>
        <small class="hc-muted">{{ phaseText }}</small>
      </div>
    </div>

    <div class="hc-bound">
      <span class="hc-muted">当前绑定任务</span>
      <strong>{{ boundTask?.title || '未绑定任务' }}</strong>
    </div>

    <div class="hc-timer-row">
      <n-button
        v-if="!state || state.phase === 'idle' || state.phase === 'break'"
        size="small"
        type="primary"
        block
        @click="start"
      >开始专注</n-button>
      <n-button v-else-if="state.phase === 'running'" size="small" block @click="pause">暂停</n-button>
      <n-button v-else size="small" type="primary" block @click="resume">继续</n-button>
      <n-button size="small" @click="router.push('/pomodoro')">全部</n-button>
    </div>

    <!-- 番茄进度用 n-tag 表示完成/未完成，避免自绘圆点 -->
    <div class="hc-tomatoes">
      <span>
        <n-tag
          v-for="n in Math.max(goal, 1)"
          :key="n"
          size="tiny"
          :type="n <= doneCount ? 'warning' : 'default'"
          round
        >{{ n }}</n-tag>
        <span class="hc-muted">今日 {{ doneCount }} 个番茄</span>
      </span>
      <span class="hc-muted">目标 {{ goal }} 个 · {{ stats?.minutes ?? 0 }} 分钟</span>
    </div>
  </n-card>
</template>