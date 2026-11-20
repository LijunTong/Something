<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useMessage, NButton, NProgress, NSelect, NTag, NEmpty, NSpace, NModal, NInputNumber, NRadioGroup, NRadio, NForm, NFormItem } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import Shell from '@/components/Shell.vue'
import { call, bridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { isTypingTarget, matchesCombo } from '@/lib/shortcut'
import type { PomodoroState, PomodoroStats, PomodoroConfig, PomodoroSessionRow } from '@/types/api'
import '@/styles/pomodoro.css'

const store = useAppStore()
const message = useMessage()

const st = ref<PomodoroState>({ phase: 'idle', remainSec: 1500, round: 1, taskId: null, endsAt: null, plannedSec: 1500 })
const cfg = ref<PomodoroConfig>({ focusMin: 25, shortMin: 5, longMin: 15, longEvery: 4, goal: 4 })
const stats = ref<PomodoroStats>({ sessions: [], count: 0, minutes: 0, interrupted: 0, rate: 0 })
const week = ref<Array<{ date: number; minutes: number; count: number }>>([])
const showAbandon = ref(false)
const abandonReason = ref('接电话')
const focusMode = ref(false)
const showFinish = ref(false)
const showSettings = ref(false)
const cfgDraft = ref<Partial<PomodoroConfig>>({})
const showTaskPicker = ref(false)
const taskPickerValue = ref<string | null>(null)
let timer: number | null = null
let ticker: number | null = null

const phaseLabel = computed(() => {
  if (st.value.phase === 'running') return '专注中'
  if (st.value.phase === 'paused') return '已暂停'
  if (st.value.phase === 'break') return '休息中'
  return '待开始'
})
const remainText = computed(() => {
  const s = Math.max(0, st.value.remainSec)
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
})
// 原型里的「距离结束还有 X 分 Y 秒」
const capText = computed(() => '距离结束还有 ' + Math.floor(st.value.remainSec / 60) + ' 分 ' + (st.value.remainSec % 60) + ' 秒')

const progress = computed(() => {
  const total = st.value.plannedSec || cfg.value.focusMin * 60
  if (!total) return 0
  return Math.min(100, Math.max(0, Math.round((1 - st.value.remainSec / total) * 100)))
})
const taskTitle = computed(() => {
  const t = store.todos.find((x) => x.id === st.value.taskId)
  return t ? t.title : '未绑定任务'
})
const taskOptions = computed(() => store.todos.filter((t) => t.status !== '已完成').map((t) => ({ label: t.title, value: t.id })))
const weekMax = computed(() => Math.max(1, ...week.value.map((d) => d.minutes)))

async function loadAll() {
  st.value = await call(() => bridge().pomodoro.state(), { phase: 'idle', remainSec: 1500, round: 1, taskId: null, endsAt: null, plannedSec: 1500 } as PomodoroState)
  cfg.value = await call(() => bridge().pomodoro.config(), { focusMin: 25, shortMin: 5, longMin: 15, longEvery: 4, goal: 4 } as PomodoroConfig)
  stats.value = await call(() => bridge().pomodoro.stats({}), { sessions: [], count: 0, minutes: 0, interrupted: 0, rate: 0 } as PomodoroStats)
  week.value = await call(() => bridge().pomodoro.weekStats(), [] as Array<{ date: number; minutes: number; count: number }>)
}

async function refreshState() {
  const next = await call(() => bridge().pomodoro.tick(), st.value)
  if (next.phase !== st.value.phase) await loadAll()
  else st.value = next
}

async function start() {
  try { st.value = await call(() => bridge().pomodoro.start({}), st.value) ; void loadAll(); message.success('开始专注') }
  catch (e) { message.error((e as Error).message) }
}
async function pause() { st.value = await call(() => bridge().pomodoro.pause(), st.value); message.info('已暂停') }
async function resume() { st.value = await call(() => bridge().pomodoro.resume(), st.value); message.success('继续专注') }
async function complete() { st.value = await call(() => bridge().pomodoro.complete(), st.value); await loadAll(); message.success('番茄完成，休息一下') }
async function skipBreak() { st.value = await call(() => bridge().pomodoro.skipBreak(), st.value); message.info('已跳过休息') }
async function abandon() {
  const next = await call(() => bridge().pomodoro.abandon({ reason: abandonReason.value }), st.value)
  st.value = next
  showAbandon.value = false
  focusMode.value = false
  await loadAll()
  message.warning('已记录中断')
}
async function bindTask(v: string | null) {
  try {
    st.value = await call(() => bridge().pomodoro.setTask({ taskId: v }), st.value)
    showTaskPicker.value = false
    message.success(v ? '已绑定任务' : '已取消绑定')
  } catch (e) {
    log.exception('pomodoro.bindTask', e)
    message.error((e as Error).message)
  }
}

/** 快捷键：F 开始 / 暂停 / 继续（组合键可在设置里改） */
function toggleFocus() {
  if (st.value.phase === 'running') void pause()
  else if (st.value.phase === 'paused') void resume()
  else void start()
}

function onShortcut(e: KeyboardEvent) {
  if (isTypingTarget(e.target)) return
  if (showAbandon.value || showSettings.value || showTaskPicker.value || showFinish.value || focusMode.value) return
  if (!matchesCombo(e, store.settings?.shortcuts?.focus || 'F')) return
  e.preventDefault()
  toggleFocus()
}

function openTaskPicker() {
  taskPickerValue.value = st.value.taskId
  showTaskPicker.value = true
}
function openSettings() {
  cfgDraft.value = { ...cfg.value }
  showSettings.value = true
}

async function saveCfg(patch: Partial<PomodoroConfig>) {
  try {
    cfg.value = await call(() => bridge().pomodoro.saveConfig(patch), cfg.value)
    showSettings.value = false
    message.success('已保存')
  } catch (e) {
    log.exception('pomodoro.saveCfg', e)
    message.error((e as Error).message)
  }
}

// 番茄完成进入休息时弹出结束提示（原型中的「结束提示」状态）
watch(() => st.value.phase, (now, prev) => {
  if (now === 'break' && prev === 'running') showFinish.value = true
})

onMounted(() => {
  void loadAll()
  window.addEventListener('keydown', onShortcut)
})
onUnmounted(() => window.removeEventListener('keydown', onShortcut))
onUnmounted(() => { if (timer) clearInterval(timer); if (ticker) clearInterval(ticker) })
</script>

<template>
  <Shell>
    <template #subtitle>今日已完成 {{ stats.count }} 个番茄 · 专注 {{ Math.floor(stats.minutes / 60) }} 小时 {{ stats.minutes % 60 }} 分</template>
    <template #actions>
      <n-button size="small" @click="focusMode = true">全屏专注模式</n-button>
      <n-button size="small" quaternary @click="openSettings">设置</n-button>
    </template>

    <div class="pm-layout">
      <section class="card pm-timer">
        <n-tag :type="st.phase === 'running' ? 'success' : st.phase === 'break' ? 'info' : 'default'" size="small">{{ phaseLabel }}</n-tag>
        <div class="pm-ring-wrap">
          <n-progress type="circle" :percentage="progress" :stroke-width="10" :show-indicator="false" style="width:232px;height:232px" />
          <div class="pm-ring-center">
            <span class="pm-time-text">{{ remainText }}</span>
            <span class="pm-cap-text muted-text">{{ capText }}</span>
          </div>
        </div>
        <div class="pm-task-row">
          当前任务：<strong>{{ taskTitle }}</strong>
          <n-button size="tiny" quaternary @click="openTaskPicker">切换任务</n-button>
        </div>
        <div class="pm-dots">
          <i v-for="n in cfg.goal" :key="n" class="pm-dot" :class="{ on: n <= st.round }"></i>
          <span>本轮第 {{ st.round }}/{{ cfg.goal }} 个番茄</span>
        </div>
        <n-space>
          <n-button v-if="st.phase === 'idle' || st.phase === 'break'" type="primary" @click="start">开始专注</n-button>
          <n-button v-if="st.phase === 'running'" @click="pause">暂停</n-button>
          <n-button v-if="st.phase === 'paused'" type="primary" @click="resume">继续</n-button>
          <n-button v-if="st.phase === 'break'" @click="skipBreak">跳过休息</n-button>
          <n-button v-if="st.phase === 'running' || st.phase === 'paused'" @click="showAbandon = true">放弃</n-button>
        </n-space>
        <div class="pm-config-note muted-text">
          专注 {{ cfg.focusMin }} 分钟 · 短休 {{ cfg.shortMin }} 分钟 · 长休 {{ cfg.longMin }} 分钟 · 每 {{ cfg.longEvery }} 轮长休
        </div>
      </section>

      <aside class="pm-side">
        <div class="card pm-card">
          <div class="card-title pm-card-title">今日统计</div>
          <div class="pm-stats">
            <div class="pm-stat"><strong>{{ stats.count }}</strong><span class="muted-text">番茄数</span></div>
            <div class="pm-stat"><strong>{{ stats.minutes }}m</strong><span class="muted-text">专注时长</span></div>
            <div class="pm-stat"><strong>{{ stats.interrupted }}</strong><span class="muted-text">中断次数</span></div>
            <div class="pm-stat"><strong>{{ stats.rate }}%</strong><span class="muted-text">完成率</span></div>
          </div>
        </div>

        <div class="card pm-card">
          <div class="card-title pm-card-title">本周专注</div>
          <div class="pm-bars">
            <div v-for="(d, i) in week" :key="d.date" class="pm-bar">
              <i :style="{ height: Math.max(3, (d.minutes / weekMax) * 100) + '%' }"></i>
              <span>{{ ['一','二','三','四','五','六','日'][i] }}</span>
            </div>
          </div>
          <div class="pm-barnote muted-text">单位：分钟 · 数据保存在本机</div>
        </div>

        <div class="card pm-card">
          <div class="card-title pm-card-title">最近会话</div>
          <div v-for="s in stats.sessions.slice(0, 5)" :key="s.id" class="pm-session">
            <span class="pm-session-name">{{ s.taskId ? (store.todos.find(t => t.id === s.taskId)?.title || '任务') : '未绑定' }}</span>
            <n-tag size="tiny" :type="s.status === '中断' ? 'warning' : 'success'">{{ s.status }}</n-tag>
            <span class="muted-text">{{ s.actualMin }} 分钟</span>
          </div>
          <n-empty v-if="!stats.sessions.length" description="还没有专注记录" size="small" />
        </div>
      </aside>
    </div>

    <!-- 切换任务 -->
    <n-modal v-model:show="showTaskPicker" preset="card" title="切换绑定任务" style="width:420px">
      <n-select
        v-model:value="taskPickerValue"
        :options="taskOptions"
        placeholder="选择一个待办任务"
        clearable
        filterable
      />
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <n-button @click="showTaskPicker = false">取消</n-button>
          <n-button type="primary" @click="bindTask(taskPickerValue)">确定</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 中断原因 -->
    <n-modal v-model:show="showAbandon" preset="card" title="记录中断原因" style="width:400px">
      <n-radio-group v-model:value="abandonReason">
        <n-space vertical>
          <n-radio v-for="r in ['接电话', '被同事打断', '临时任务', '其他']" :key="r" :value="r">{{ r }}</n-radio>
        </n-space>
      </n-radio-group>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <n-button @click="showAbandon = false">继续专注</n-button>
          <n-button type="primary" @click="abandon">确认中断</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 结束提示 -->
    <n-modal v-model:show="showFinish" preset="card" title="专注完成" style="width:380px">
      <div style="text-align:center">
        <div style="font-size:15px">专注完成！休息 {{ st.phase === 'break' ? cfg.shortMin : 5 }} 分钟吧</div>
        <div class="muted-text" style="margin-top:6px">已完成 {{ stats.count }} 个番茄</div>
      </div>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <n-button @click="showFinish = false; skipBreak()">跳过休息</n-button>
          <n-button type="primary" @click="showFinish = false">开始休息</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 时长设置 -->
    <n-modal v-model:show="showSettings" preset="card" title="番茄钟设置" style="width:400px">
      <n-form label-placement="left" label-width="96" size="small">
        <n-form-item label="专注时长(分)"><n-input-number v-model:value="cfgDraft.focusMin" :min="1" :max="180" style="width:100%" /></n-form-item>
        <n-form-item label="短休(分)"><n-input-number v-model:value="cfgDraft.shortMin" :min="1" :max="60" style="width:100%" /></n-form-item>
        <n-form-item label="长休(分)"><n-input-number v-model:value="cfgDraft.longMin" :min="1" :max="120" style="width:100%" /></n-form-item>
        <n-form-item label="长休间隔"><n-input-number v-model:value="cfgDraft.longEvery" :min="2" :max="12" style="width:100%" /></n-form-item>
      </n-form>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <n-button @click="showSettings = false">取消</n-button>
          <n-button type="primary" @click="saveCfg(cfgDraft)">保存</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 全屏专注 -->
    <div v-if="focusMode" class="pm-focus" style="background:var(--focus-bg);color:var(--on-primary)">
      <div class="pm-focus-time">{{ remainText }}</div>
      <div style="font-size:20px;color:var(--muted)">{{ taskTitle }}</div>
      <div class="pm-focus-hint" style="color:var(--muted)">保持专注，勿扰模式已开启</div>
      <div class="pm-focus-btns">
        <n-button @click="st.phase === 'running' ? pause() : resume()">{{ st.phase === 'running' ? '暂停' : '继续' }}</n-button>
        <n-button @click="focusMode = false">结束专注</n-button>
      </div>
    </div>
  </Shell>
</template>

