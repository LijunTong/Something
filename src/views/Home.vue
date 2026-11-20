<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NTag, NButton, NEmpty, NDrawer, NDrawerContent } from 'naive-ui'
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
import { useHomeCards } from '@/composables/useHomeCards'
import { triggerHomeRefresh } from '@/composables/useHomeRefresh'
import CardSettingsPanel from '@/components/home/CardSettingsPanel.vue'
import '@/styles/home.css'

const router = useRouter()
/** 卡片显隐与卡片菜单读同一份设置（见 useHomeCards） */
const { shown, hiddenCount } = useHomeCards()
const showCards = ref(false)
const anyCard = computed(() => hiddenCount.value < 8)

const WEEKS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const now = ref(new Date())
const updatedAt = ref('')
let clock: ReturnType<typeof setInterval> | null = null
let unsubscribe: (() => void) | null = null

const dateText = computed(() => {
  const d = now.value
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + WEEKS[d.getDay()]
})
const timeText = computed(() => {
  const d = now.value
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
})

/** 刷新走令牌：卡片就地重载，不重挂载，滚动位置与卡片高度都不受影响 */
function refresh() {
  updatedAt.value = timeText.value
  triggerHomeRefresh()
}

onMounted(() => {
  updatedAt.value = timeText.value
  clock = setInterval(() => { now.value = new Date() }, 30000)
  if (hasBridge()) {
    // 任一模块写库后刷新卡片；离开首页时解绑，避免监听器累积导致重复刷新
    unsubscribe = bridge().onDataChanged(() => refresh())
  }
})
onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
  if (unsubscribe) { unsubscribe(); unsubscribe = null }
})
</script>

<template>
  <Shell>
    <template #subtitle>{{ dateText }} · 数据更新于 {{ updatedAt || timeText }}（本地缓存）</template>
    <template #actions>
      <n-tag size="small" type="success">本地数据</n-tag>
      <n-tag v-if="hiddenCount" size="small" type="warning">{{ hiddenCount }} 张卡片已隐藏</n-tag>
      <n-button size="small" @click="showCards = true">卡片设置</n-button>
      <n-button size="small" @click="refresh">刷新</n-button>
    </template>

    <div v-if="anyCard" class="home-grid">
      <WeatherCard v-if="shown('weather')" />
      <ScheduleCard v-if="shown('schedule')" class="home-span2" />
      <TodoCard v-if="shown('todo')" />
      <PomodoroCard v-if="shown('pomodoro')" />
      <ParcelCard v-if="shown('parcel')" />
      <FeedCard v-if="shown('feed')" />
      <MailCard v-if="shown('mail')" class="home-span2" />
      <NoticeCard v-if="shown('notice')" />
    </div>
    <div v-else class="card">
      <n-empty description="首页卡片都被隐藏了">
        <n-button size="small" @click="showCards = true">打开卡片设置</n-button>
      </n-empty>
    </div>

    <n-drawer v-model:show="showCards" :width="420" placement="right">
      <n-drawer-content title="卡片设置" closable :native-scrollbar="false">
        <CardSettingsPanel />
      </n-drawer-content>
    </n-drawer>
  </Shell>
</template>
