<script setup lang="ts">
// 应用内通知宿主：主进程把事件推成浮层（Naive UI notification），点击跳到对应模块。
// 系统通知由主进程直接出 toast，这里只负责「应用内」这一条通道。
import { h, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, useNotification } from 'naive-ui'
import { bridge, hasBridge } from '@/lib/ipc'
import { playNotifySound } from '@/composables/useNotifySound'
import { log } from '@/lib/logger'
import type { NotificationEvent } from '@/types/api'

const router = useRouter()
const notification = useNotification()

const MODULE_LABEL: Record<string, string> = {
  weather: '天气', schedule: '日程', todo: '待办',
  pomodoro: '番茄钟', parcel: '快递', mail: '邮件', system: '系统'
}
const MODULE_ROUTE: Record<string, string> = {
  weather: '/weather', schedule: '/schedule', todo: '/todo',
  pomodoro: '/pomodoro', parcel: '/parcel', mail: '/mail', system: '/settings'
}

/** 同一事件只浮一次：主进程有去重，这里再兜一层（订阅重放 / 多次挂载） */
const shown = new Set<string>()
let off: (() => void) | null = null

function clockText(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function present(e: NotificationEvent) {
  if (!e || !e.id || !e.title) return
  if (shown.has(e.id)) return
  shown.add(e.id)
  // 提示音按模块配置播放：系统通知在 Windows 上播不了自定义音频，统一走这里
  playNotifySound(e.sound)
  const to = MODULE_ROUTE[e.module] || '/'
  const inst = notification.create({
    title: e.title,
    content: e.body || MODULE_LABEL[e.module] || '新提醒',
    meta: clockText(e.at || Date.now()) + ' · ' + (MODULE_LABEL[e.module] || '通知'),
    duration: e.level === 'strong' ? 9000 : 5000,
    keepAliveOnHover: true,
    // 浮层本身不带点击回调，用「查看」动作跳到对应模块
    action: () => h(NButton, {
      size: 'tiny',
      secondary: true,
      type: 'primary',
      onClick: () => { inst.destroy(); void router.push(to) }
    }, { default: () => '查看' })
  })
}

onMounted(() => {
  if (!hasBridge()) return
  try {
    off = bridge().notification.onEvent((e) => present(e))
  } catch (err) {
    log.exception('notify.host', err)
  }
})

onBeforeUnmount(() => {
  if (off) { off(); off = null }
})
</script>

<template>
  <!-- 只做订阅，不渲染任何 DOM -->
  <span style="display:none" aria-hidden="true" />
</template>
