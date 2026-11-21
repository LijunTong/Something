<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NCard, NTag, NEmpty, NSpin, NButton, useMessage } from 'naive-ui'
import { useRouter } from 'vue-router'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { NotificationItem } from '@/types/api'

const message = useMessage()
const router = useRouter()
const items = ref<NotificationItem[]>([])
const loading = ref(false)
const marking = ref(false)

const ICONS: Record<string, string> = {
  schedule: '#i-clock', todo: '#i-check', parcel: '#i-box', mail: '#i-mail', weather: '#i-sun'
}

const list = computed(() => items.value.slice(0, 3))
const unread = computed(() => items.value.filter((i) => !i.read).length)

function idOf(moduleName: string): string {
  return ICONS[moduleName] || '#i-bell'
}
function timeText(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

async function load() {
  if (!hasBridge()) return
  loading.value = true
  try {
    items.value = await call(() => bridge().notification.today(), [] as NotificationItem[])
  } catch (e) {
    log.exception('home.notice', e)
  } finally {
    loading.value = false
  }
}

async function markAll() {
  marking.value = true
  try {
    await call(() => bridge().notification.markAllRead(), 0)
    message.success('今日提醒已全部标记为已读')
    await load()
  } catch (e) {
    log.exception('home.notice.read', e)
    message.error('操作失败：' + ((e as Error).message || '未知错误'))
  } finally {
    marking.value = false
  }
}

/** 主进程推送新通知后（系统通知与应用内同一事件源）刷新卡片 */
let offNotify: (() => void) | null = null
onMounted(() => {
  void load()
  if (!hasBridge()) return
  offNotify = bridge().onDataChanged((p) => { if (p.domain === 'notification') void load() })
})
onBeforeUnmount(() => {
  if (offNotify) { offNotify(); offNotify = null }
})
const refreshTick = useHomeCardRefresh('notice')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-notice">
    <template #header>
      <div class="hc-head">
        <span>今日通知</span>
        <n-tag size="tiny" :type="unread ? 'warning' : 'success'">{{ unread ? unread + ' 条待处理' : '全部已读' }}</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <n-button size="tiny" quaternary @click="router.push('/notice')">查看全部</n-button>
          <n-button size="tiny" quaternary :disabled="!unread" :loading="marking" @click="markAll">全部已读</n-button>
          <HomeCardMenu module="notice" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty v-if="!list.length" size="small" description="暂无新提醒" />
      <div v-for="n in list" :key="n.id" class="hc-notice-row">
        <svg class="hc-ico" viewBox="0 0 24 24"><use :href="idOf(n.module)" /></svg>
        <span class="hc-notice-main">
          <strong>{{ n.title }}</strong>
          <small class="hc-muted">{{ n.body || n.module }} · {{ timeText(n.at) }}</small>
        </span>
      </div>
    </n-spin>

    <template #footer>
      <span class="hc-muted">今日共 {{ items.length }} 条 · 未读 {{ unread }} 条 · 点「查看全部」统一管理</span>
    </template>
  </n-card>
</template>