<script setup lang="ts">
// 通知中心：本机全部通知的统一管理页（事件通知行 + 规则派生提醒）。
// 与首页「今日通知」卡片同一口径：写操作后主进程广播 data:changed(notification)，
// 卡片、侧栏角标与本页一起刷新，不需要各自再定规则。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NBadge, NButton, NCard, NEmpty, NPopconfirm, NRadioButton, NRadioGroup,
  NSelect, NSpin, NTag, NText, useMessage
} from 'naive-ui'
import Shell from '@/components/Shell.vue'
import { bridge, call, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { NotificationItem, NotifyCounts, NotifyPage } from '@/types/api'
import '@/styles/notice.css'

const router = useRouter()
const message = useMessage()

const MODULE_LABEL: Record<string, string> = {
  schedule: '日程', todo: '待办', pomodoro: '番茄钟', parcel: '快递', mail: '邮件', weather: '天气', system: '系统'
}
const MODULE_ICON: Record<string, string> = {
  schedule: '#i-clock', todo: '#i-check', pomodoro: '#i-timer', parcel: '#i-box',
  mail: '#i-mail', weather: '#i-sun', system: '#i-bell'
}
const MODULE_ROUTE: Record<string, string> = {
  schedule: '/schedule', todo: '/todo', pomodoro: '/pomodoro', parcel: '/parcel',
  mail: '/mail', weather: '/weather', system: '/settings'
}

const MODULE_OPTIONS = [
  { label: '全部模块', value: '' },
  { label: '日程', value: 'schedule' },
  { label: '待办', value: 'todo' },
  { label: '番茄钟', value: 'pomodoro' },
  { label: '快递', value: 'parcel' },
  { label: '邮件', value: 'mail' },
  { label: '天气', value: 'weather' },
  { label: '系统', value: 'system' }
]

const PAGE_SIZE = 60
const items = ref<NotificationItem[]>([])
const counts = ref<NotifyCounts>({ total: 0, unread: 0, byModule: {} })
const loading = ref(false)
const busy = ref('')
const onlyUnread = ref(false)
const moduleFilter = ref('')
const hasMore = ref(false)
let offNotify: (() => void) | null = null

const subtitle = computed(() =>
  '共 ' + counts.value.total + ' 条 · 未读 ' + counts.value.unread + ' 条 · 日程 / 待办 / 番茄钟 / 快递 / 邮件 / 天气统一在这里'
)

/** 按自然日分组：今天 / 昨天 / 更早，长列表才有时间坐标 */
const groups = computed(() => {
  const startToday = new Date()
  startToday.setHours(0, 0, 0, 0)
  const todayAt = startToday.getTime()
  const yesterdayAt = todayAt - 86400000
  const buckets: Array<{ key: string; label: string; items: NotificationItem[] }> = [
    { key: 'today', label: '今天', items: [] },
    { key: 'yesterday', label: '昨天', items: [] },
    { key: 'earlier', label: '更早', items: [] }
  ]
  items.value.forEach((n) => {
    if (n.at >= todayAt) buckets[0].items.push(n)
    else if (n.at >= yesterdayAt) buckets[1].items.push(n)
    else buckets[2].items.push(n)
  })
  return buckets.filter((b) => b.items.length > 0)
})

function labelOf(moduleName: string): string {
  return MODULE_LABEL[moduleName] || moduleName
}

function iconOf(moduleName: string): string {
  return MODULE_ICON[moduleName] || '#i-bell'
}

function clockText(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function loadCounts() {
  const c = await call(() => bridge().notification.counts(), null as unknown as NotifyCounts)
  if (c) counts.value = c
}

async function load(append = false) {
  if (!hasBridge()) return
  if (loading.value) return
  loading.value = true
  try {
    const offset = append ? items.value.length : 0
    const page = await call(
      () => bridge().notification.list({
        module: moduleFilter.value || undefined,
        onlyUnread: onlyUnread.value || undefined,
        limit: PAGE_SIZE,
        offset
      }),
      { items: [], total: 0, offset: 0, limit: PAGE_SIZE, hasMore: false } as NotifyPage
    )
    items.value = append ? items.value.concat(page.items) : page.items
    hasMore.value = page.hasMore
    if (!append) await loadCounts()
  } catch (e) {
    log.exception('notice.list', e)
    message.error('读取通知失败：' + errMsg(e))
  } finally {
    loading.value = false
  }
}

/** 写操作后主进程会广播，这里主动再拉一次，避免广播在浏览器预览里不存在 */
async function afterWrite() {
  await load(false)
}

async function markAll() {
  busy.value = 'all'
  try {
    await call(() => bridge().notification.markAllRead(), 0)
    message.success('已全部标记为已读')
    await afterWrite()
  } catch (e) {
    log.exception('notice.markAll', e)
    message.error('操作失败：' + errMsg(e))
  } finally {
    busy.value = ''
  }
}

async function markOne(item: NotificationItem) {
  try {
    await call(() => bridge().notification.markRead(item.id), false)
    item.read = true
    await loadCounts()
  } catch (e) {
    log.exception('notice.markRead', e)
    message.error('操作失败：' + errMsg(e))
  }
}

async function removeOne(item: NotificationItem) {
  try {
    await call(() => bridge().notification.remove(item.id), false)
    items.value = items.value.filter((n) => n.id !== item.id)
    await loadCounts()
  } catch (e) {
    log.exception('notice.remove', e)
    message.error('删除失败：' + errMsg(e))
  }
}

async function clearRead() {
  busy.value = 'clear'
  try {
    const n = await call(() => bridge().notification.clearRead(), 0)
    message.success('已清除 ' + n + ' 条已读通知')
    await afterWrite()
  } catch (e) {
    log.exception('notice.clearRead', e)
    message.error('清除失败：' + errMsg(e))
  } finally {
    busy.value = ''
  }
}

/** 点模块图标跳到来源页面：通知的落点必须是产生它的地方 */
function openModule(item: NotificationItem) {
  const to = MODULE_ROUTE[item.module]
  if (to) void router.push(to)
}

watch([onlyUnread, moduleFilter], () => { void load(false) })

onMounted(() => {
  void load(false)
  if (!hasBridge()) return
  offNotify = bridge().onDataChanged((p) => {
    if (p.domain === 'notification') void load(false)
  })
})

onBeforeUnmount(() => {
  if (offNotify) { offNotify(); offNotify = null }
})
</script>

<template>
  <Shell>
    <template #subtitle>{{ subtitle }}</template>
    <template #actions>
      <n-button size="small" :disabled="!counts.unread" :loading="busy === 'all'" @click="markAll">全部已读</n-button>
      <n-popconfirm @positive-click="clearRead">
        <template #trigger>
          <n-button size="small" :loading="busy === 'clear'">清除已读</n-button>
        </template>
        删除所有已读通知？连同已读的提醒类条目一起清空。
      </n-popconfirm>
    </template>

    <n-card size="small" class="nt-card">
      <div class="nt-toolbar">
        <n-radio-group v-model:value="onlyUnread" size="small">
          <n-radio-button :value="false">全部</n-radio-button>
          <n-radio-button :value="true">未读</n-radio-button>
        </n-radio-group>
        <n-select class="nt-module" size="small" v-model:value="moduleFilter" :options="MODULE_OPTIONS" />
        <div class="nt-toolbar-end">
          <span class="nt-count">{{ items.length }} / {{ counts.total }} 条</span>
        </div>
      </div>

      <n-spin :show="loading">
        <n-empty v-if="!items.length" class="nt-empty" description="没有符合条件的通知">
          <template #extra>
            <span class="nt-muted">日程、待办到期、番茄钟结束、快递状态与邮件都会在这里留下记录</span>
          </template>
        </n-empty>

        <template v-else>
          <div v-for="g in groups" :key="g.key" class="nt-group">
            <div class="nt-group-title">{{ g.label }}</div>
            <div v-for="n in g.items" :key="n.id" class="nt-row">
              <button type="button" class="nt-ico" :title="'打开' + labelOf(n.module)" @click="openModule(n)">
                <n-badge dot :show="!n.read" :offset="[2, 0]">
                  <svg viewBox="0 0 24 24"><use :href="iconOf(n.module)" /></svg>
                </n-badge>
              </button>
              <div class="nt-main">
                <span class="nt-title">
                  <n-text v-if="!n.read" strong>{{ n.title }}</n-text>
                  <span v-else>{{ n.title }}</span>
                  <n-tag v-if="n.level === 'strong'" size="tiny" type="warning">强提醒</n-tag>
                  <n-tag v-if="n.derived" size="tiny">规则</n-tag>
                </span>
                <span class="nt-body">{{ n.body || labelOf(n.module) }}</span>
              </div>
              <div class="nt-side">
                <n-tag size="tiny" :bordered="false">{{ labelOf(n.module) }}</n-tag>
                <span class="nt-time">{{ clockText(n.at) }}</span>
                <div class="nt-actions">
                  <n-button v-if="!n.read" size="tiny" quaternary @click="markOne(n)">标为已读</n-button>
                  <n-popconfirm v-if="!n.derived" @positive-click="removeOne(n)">
                    <template #trigger><n-button size="tiny" quaternary type="error">删除</n-button></template>
                    删除这条通知？不影响产生它的数据。
                  </n-popconfirm>
                </div>
              </div>
            </div>
          </div>

          <div v-if="hasMore" class="nt-more">
            <n-button size="small" :loading="loading" @click="load(true)">加载更多</n-button>
          </div>
        </template>
      </n-spin>
    </n-card>
  </Shell>
</template>
