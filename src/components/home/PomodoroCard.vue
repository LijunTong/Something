<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NProgress, NButton, NEmpty, NModal, NForm, NFormItem, NInputNumber, useMessage } from 'naive-ui'
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

/** 时长设置：入口在卡片菜单里，弹窗内改专注/休息分钟数与每日目标，保存即写配置 */
const showConfig = ref(false)
const saving = ref(false)
const cfg = ref({ focusMin: 25, shortMin: 5, longMin: 15, goal: 4 })

function onMenu(key: string) {
  if (key === 'config') openConfig()
  // 全屏专注：不弹窗，直接带着 ?immersive=1 进番茄钟页，Shell 会因此隐藏侧栏与顶栏
  else if (key === 'immersive') void router.push({ path: '/pomodoro', query: { immersive: '1' } })
}
function openConfig() {
  const c = config.value
  cfg.value = {
    focusMin: c?.focusMin ?? 25,
    shortMin: c?.shortMin ?? 5,
    longMin: c?.longMin ?? 15,
    goal: c?.goal ?? 4
  }
  showConfig.value = true
}
async function saveConfig() {
  saving.value = true
  try {
    const next = await call(() => bridge().pomodoro.saveConfig({
      focusMin: Math.max(1, Math.round(cfg.value.focusMin)),
      shortMin: Math.max(1, Math.round(cfg.value.shortMin)),
      longMin: Math.max(1, Math.round(cfg.value.longMin)),
      goal: Math.max(1, Math.round(cfg.value.goal))
    }), null as unknown as PomodoroConfig)
    if (next) config.value = next
    message.success('已保存时长设置')
    showConfig.value = false
    await load()
  } catch (e) {
    log.exception('home.pomodoro.config', e)
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  } finally {
    saving.value = false
  }
}

const refreshTick = useHomeCardRefresh('pomodoro')
watch(refreshTick, () => { void load() })

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
        <!-- 只有标题文字进番茄页，卡片其它区域不跳转 -->
        <n-button text size="small" @click="router.push('/pomodoro')">番茄钟</n-button>
        <n-tag size="tiny" :type="state?.phase === 'running' ? 'success' : 'default'">{{ phaseText }}</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <HomeCardMenu
            module="pomodoro"
            :actions="[{ label: '全屏专注', key: 'immersive' }, { label: '时长设置', key: 'config' }]"
            @action="onMenu"
          />
        </div>
      </template>

    <div class="hc-dial">
      <!-- 与番茄钟页同样的写法（Pomodoro.vue:186）：尺寸靠内联 style 定，
           因为 app.css 的 `.n-progress svg { width:100%; height:100% }` 只让 SVG 跟随容器，
           而 Naive 自己给根节点写了 inline 宽高，class 改不动它 -->
      <n-progress
        type="circle"
        status="info"
        :percentage="pct"
        :stroke-width="5"
        :show-indicator="false"
        class="hc-dial-ring"
        style="width: 84px; height: 84px"
      />
      <!-- 环内两行：时间与今日进度。用 flex 居中，不受行高与基线影响，不会出现数字偏上偏左 -->
      <div class="hc-dial-text">
        <strong>{{ mmss(remain || plannedSec) }}</strong>
        <span class="hc-dial-sub hc-muted">{{ doneCount }}/{{ goal }}</span>
      </div>
    </div>

    <!-- 绑定任务：去掉「当前绑定任务」这行提示，只留任务名并居中；含义交给 title 提示 -->
    <div
      class="hc-bound hc-row-link"
      role="button"
      tabindex="0"
      :title="'当前绑定任务：' + (boundTask?.title || '未绑定任务')"
      @click="router.push('/pomodoro')"
      @keydown.enter="router.push('/pomodoro')"
    >
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

  <n-modal v-model:show="showConfig" to="body" preset="card" style="width:420px" title="时长设置">
    <n-form label-placement="left" :label-width="92">
      <n-form-item label="专注时长">
        <n-input-number v-model:value="cfg.focusMin" :min="1" :max="180" style="width:100%">
          <template #suffix>分钟</template>
        </n-input-number>
      </n-form-item>
      <n-form-item label="短休息">
        <n-input-number v-model:value="cfg.shortMin" :min="1" :max="60" style="width:100%">
          <template #suffix>分钟</template>
        </n-input-number>
      </n-form-item>
      <n-form-item label="长休息">
        <n-input-number v-model:value="cfg.longMin" :min="1" :max="120" style="width:100%">
          <template #suffix>分钟</template>
        </n-input-number>
      </n-form-item>
      <n-form-item label="每日目标">
        <n-input-number v-model:value="cfg.goal" :min="1" :max="30" style="width:100%">
          <template #suffix>个</template>
        </n-input-number>
      </n-form-item>
    </n-form>
    <template #footer>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <n-button size="small" @click="showConfig = false">取消</n-button>
        <n-button size="small" type="primary" :loading="saving" @click="saveConfig">保存</n-button>
      </div>
    </template>
  </n-modal>
</template>