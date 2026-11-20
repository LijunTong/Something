<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NTag, NButton } from 'naive-ui'
import Shell from '@/components/Shell.vue'
import WeatherCard from '@/components/home/WeatherCard.vue'
import ScheduleCard from '@/components/home/ScheduleCard.vue'
import TodoCard from '@/components/home/TodoCard.vue'
import PomodoroCard from '@/components/home/PomodoroCard.vue'
import ParcelCard from '@/components/home/ParcelCard.vue'
import FeedCard from '@/components/home/FeedCard.vue'
import MailCard from '@/components/home/MailCard.vue'
import NoticeCard from '@/components/home/NoticeCard.vue'
import { bridge, hasBridge } from '@/lib/ipc'
import '@/styles/home.css'

const WEEKS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const now = ref(new Date())
const reloadKey = ref(0)
const updatedAt = ref('')
let clock: ReturnType<typeof setInterval> | null = null

const dateText = computed(() => {
  const d = now.value
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + WEEKS[d.getDay()]
})
const timeText = computed(() => {
  const d = now.value
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
})

function refresh() {
  updatedAt.value = timeText.value
  reloadKey.value += 1
}

onMounted(() => {
  updatedAt.value = timeText.value
  clock = setInterval(() => { now.value = new Date() }, 30000)
  if (hasBridge()) {
    // 任一模块写库后刷新卡片，避免首页显示过期状态
    bridge().onDataChanged(() => refresh())
  }
})
onBeforeUnmount(() => { if (clock) clearInterval(clock) })
</script>

<template>
  <Shell>
    <template #subtitle>{{ dateText }} · 数据更新于 {{ updatedAt || timeText }}（本地缓存）</template>
    <template #actions>
      <n-tag size="small" type="success">本地数据</n-tag>
      <n-tag size="small">8 个模块</n-tag>
      <n-button size="small" @click="refresh">刷新</n-button>
    </template>

    <div class="home-grid">
      <WeatherCard :key="'wx-' + reloadKey" />
      <ScheduleCard :key="'sch-' + reloadKey" class="home-span2" />
      <TodoCard :key="'td-' + reloadKey" />
      <PomodoroCard :key="'pm-' + reloadKey" />
      <ParcelCard :key="'pc-' + reloadKey" />
      <FeedCard :key="'fd-' + reloadKey" />
      <MailCard :key="'ml-' + reloadKey" class="home-span2" />
      <NoticeCard :key="'nt-' + reloadKey" />
    </div>
  </Shell>
</template>
