<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NEmpty, NSpin, NButton, NTimeline, NTimelineItem, NModal, NForm, NFormItem, NInput, NSelect, NDatePicker, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { triggerHomeRefresh } from '@/composables/useHomeRefresh'
import type { ScheduleRow } from '@/types/api'

const router = useRouter()
const message = useMessage()
const rows = ref<ScheduleRow[]>([])
const loading = ref(false)

function dayStart(d = new Date()): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}
function hhmm(ts: number): string {
  const d = new Date(ts)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}
function minutes(row: ScheduleRow): number {
  return Math.max(0, Math.round((row.endAt - row.startAt) / 60000))
}
const list = computed(() => rows.value.slice(0, 3))

async function load() {
  if (!hasBridge()) return
  loading.value = true
  try {
    const from = dayStart()
    rows.value = await call(() => bridge().schedule.range({ from, to: from + 86400000 }), [] as ScheduleRow[])
  } catch (e) {
    log.exception('home.schedule', e)
  } finally {
    loading.value = false
  }
}
/** 新增日程：入口在卡片菜单里，弹窗内填写后直接创建，不跳日程页 */
const showCreate = ref(false)
const saving = ref(false)
const form = ref({ title: '', range: null as [number, number] | null, place: '', remindMin: 0, note: '' })

function openCreate() {
  const now = Date.now()
  form.value = { title: '', range: [now, now + 3600000], place: '', remindMin: 0, note: '' }
  showCreate.value = true
}
function onMenu(key: string) {
  if (key === 'create') openCreate()
}
async function submitCreate() {
  const title = form.value.title.trim()
  const r = form.value.range
  if (!title) { message.warning('先写个日程标题'); return }
  if (!r || !r[0] || !r[1]) { message.warning('选一下开始和结束时间'); return }
  saving.value = true
  try {
    await call(() => bridge().schedule.create({
      title,
      startAt: r[0],
      endAt: r[1],
      place: form.value.place || null,
      remindMin: form.value.remindMin,
      note: form.value.note || null
    }))
    message.success('已添加日程')
    showCreate.value = false
    await load()
    triggerHomeRefresh('schedule')
  } catch (e) {
    message.error('添加失败：' + ((e as Error).message || '未知错误'))
  } finally {
    saving.value = false
  }
}

onMounted(load)
const refreshTick = useHomeCardRefresh('schedule')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-schedule">
    <template #header>
      <div class="hc-head">
        <!-- 只有标题文字进日程页，卡片其它区域不跳转 -->
        <n-button text size="small" @click="router.push('/schedule')">今日日程</n-button>
        <n-tag size="tiny">{{ rows.length }} 条</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <HomeCardMenu module="schedule" :actions="[{ label: '新增日程', key: 'create' }]" @action="onMenu" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty v-if="!list.length" size="small" description="今天没有安排" />
      <!-- 时间轴用 Naive UI 的 n-timeline，节点颜色/连线由主题提供，不手写圆点 -->
      <n-timeline v-else size="medium">
        <n-timeline-item
          v-for="(row, i) in list"
          :key="row.id + '-' + i"
          :title="row.title"
          :time="(row.allDay ? '全天' : hhmm(row.startAt)) + (row.allDay ? '' : ' · ' + minutes(row) + ' 分钟')"
          :type="row.remindMin > 0 ? 'warning' : 'info'"
          class="hc-row-link"
          role="button"
          tabindex="0"
          @click="router.push({ path: '/schedule', query: { focus: row.id, at: String(row.startAt) } })"
          @keydown.enter="router.push({ path: '/schedule', query: { focus: row.id, at: String(row.startAt) } })"
        >
          <div class="hc-tl-row">
            <n-tag v-if="row.calendarName" size="tiny">{{ row.calendarName }}</n-tag>
            <n-tag v-if="row.remindMin > 0" size="tiny" type="warning">提前 {{ row.remindMin }} 分钟</n-tag>
            <span class="hc-muted">{{ row.place || row.note || '未填写地点' }}</span>
          </div>
        </n-timeline-item>
      </n-timeline>
    </n-spin>

    <template #footer>
      <span class="hc-muted">时间轴来自本机日程 · 提前提醒已按每条日程设置</span>
    </template>
  </n-card>

  <n-modal v-model:show="showCreate" to="body" preset="card" style="width:500px" title="新增日程">
    <n-form label-placement="left" :label-width="60">
      <n-form-item label="标题">
        <n-input v-model:value="form.title" placeholder="做什么？" @keydown.enter="submitCreate" />
      </n-form-item>
      <n-form-item label="时间">
        <n-date-picker v-model:value="form.range" type="datetimerange" clearable style="width:100%" />
      </n-form-item>
      <n-form-item label="地点">
        <n-input v-model:value="form.place" placeholder="可选" />
      </n-form-item>
      <n-form-item label="提醒">
        <n-select
          v-model:value="form.remindMin"
          :options="[{ label: '不提醒', value: 0 }, { label: '提前 5 分钟', value: 5 }, { label: '提前 15 分钟', value: 15 }, { label: '提前 30 分钟', value: 30 }, { label: '提前 1 小时', value: 60 }]"
        />
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