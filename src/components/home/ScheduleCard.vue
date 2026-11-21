<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NEmpty, NSpin, NButton, NTimeline, NTimelineItem } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { ScheduleRow } from '@/types/api'

const router = useRouter()
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
onMounted(load)
const refreshTick = useHomeCardRefresh('schedule')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-schedule">
    <template #header>
      <div class="hc-head">
        <span>今日日程</span>
        <n-tag size="tiny">{{ rows.length }} 条</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <n-button size="tiny" quaternary @click="router.push('/schedule')">查看全部</n-button>
          <HomeCardMenu module="schedule" />
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
</template>