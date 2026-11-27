<script setup lang="ts">
// 全局更新弹窗：设置页「检查更新」按钮与启动时的通知都复用它，挂在 App.vue 根部。
//
// 之所以做成全局单例而不是塞在设置页里：下载在弹窗关闭后仍会继续（主进程单例任务），
// 从托盘再点开时要能直接接上进度，而不是重新开一个只显示「检查中」的新面板。
import { computed, h, onBeforeUnmount, onMounted } from 'vue'
import { NButton, useMessage, useNotification } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import {
  checkUpdate,
  formatBytes,
  ignoreUpdateVersion,
  initUpdate,
  markAnnounced,
  openReleasePage,
  retryUpdate,
  runUpdateInstall,
  shouldAnnounce,
  snoozeUpdate,
  startUpdateDownload,
  updateState
} from '@/composables/useUpdate'

const s = updateState()
const message = useMessage()
const notification = useNotification()

const show = computed({
  get: () => s.visible,
  set: (v: boolean) => {
    s.visible = v
  }
})

const busy = computed(() => s.phase === 'downloading' || s.phase === 'installing')
// 卡片宽度跟着内容走：只有更新详情与下载进度需要宽一点，其余状态用窄卡片，别铺成整屏空白
const cardWidth = computed(() => (s.phase === 'details' || s.phase === 'downloading' ? '480px' : '360px'))
const hasUpdate = computed(() => !!s.info?.hasUpdate)
const version = computed(() => s.info?.latest || '')
const currentVersion = computed(() => s.info?.current || '')
const notes = computed(() => (s.info?.notes || '').trim())
const meta = computed(() => {
  const parts: string[] = []
  if (s.info?.publishedAt) parts.push('发布于 ' + formatDate(s.info.publishedAt))
  if (s.info?.asset?.size) parts.push('安装包 ' + formatBytes(s.info.asset.size))
  return parts.join(' · ')
})

const eta = computed(() => {
  if (s.phase !== 'downloading' || !s.speed || !s.total) return ''
  const sec = Math.round(Math.max(0, s.total - s.received) / s.speed)
  if (!isFinite(sec) || sec <= 0) return ''
  if (sec < 60) return '剩余约 ' + sec + ' 秒'
  return '剩余约 ' + Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒'
})

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function close() {
  s.visible = false
}

async function onDownload() {
  const r = await startUpdateDownload()
  if (r === 'noAsset') message.warning('该版本没有提供 Windows 安装包，可到发布页手动下载')
  else if (r === 'latest') message.info('当前已是最新版本')
  else if (r === 'failed') message.error(s.error || '下载失败')
}

async function onInstall() {
  const ok = await runUpdateInstall()
  if (!ok) message.error(s.error || '启动安装程序失败')
}

function onRetry() {
  void retryUpdate()
}

function onSnooze() {
  void snoozeUpdate(24)
  s.visible = false
  message.info('24 小时后再提醒')
}

function onIgnore() {
  void ignoreUpdateVersion(version.value)
  s.visible = false
  message.info('已忽略版本 ' + version.value + '，有更新版本时再提示')
}

/** 通知里的三个动作，用渲染函数放进去（n-notification 只接受 VNode） */
function notifyActions() {
  return h(
    'div',
    { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } },
    [
      h(NButton, { size: 'small', type: 'primary', onClick: () => { dismissNote(); s.visible = true; s.phase = 'details' } }, { default: () => '查看详情' }),
      h(NButton, { size: 'small', tertiary: true, onClick: () => { dismissNote(); void snoozeUpdate(24) } }, { default: () => '稍后提醒' }),
      h(NButton, { size: 'small', tertiary: true, onClick: () => { dismissNote(); void ignoreUpdateVersion(version.value) } }, { default: () => '忽略此版本' })
    ]
  )
}

// 通知一旦被点过动作就收掉：否则「稍后提醒 / 忽略此版本」之后它还会挂满 15 秒，
// 看起来像没生效，也正好是用户最烦的反复打扰。
let note: { destroy: () => void } | null = null
function dismissNote() {
  if (!note) return
  note.destroy()
  note = null
}

function announce() {
  if (!shouldAnnounce(s.info)) return
  markAnnounced(version.value)
  note = notification.info({
    title: '发现新版本 ' + version.value,
    content: () => '当前 ' + currentVersion.value + '，新版本 ' + version.value + (s.info?.publishedAt ? '（' + formatDate(s.info.publishedAt) + ' 发布）' : ''),
    meta: '点「查看详情」看更新日志，确认后再下载',
    duration: 15000,
    keepAliveOnHover: true,
    action: notifyActions
  })
  ;(window as unknown as Record<string, unknown>).__updNote = note
}

onBeforeUnmount(() => { dismissNote() })

onMounted(async () => {
  void initUpdate()
  // 自动检查受 settings.update.autoCheck 控制；用户关掉后只在手动点按钮时请求
  const store = useAppStore()
  if (!store.settings) await store.refreshSettings()
  if (store.settings?.update?.autoCheck === false) return
  await checkUpdate()
  announce()
})
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    title="软件更新"
    class="upd-modal"
    :style="{ width: cardWidth }"
    :bordered="false"
    :mask-closable="!busy"
    :close-on-esc="!busy"
  >
    <div class="upd-body">
      <!-- 检查中 -->
      <div v-if="s.phase === 'checking'" class="upd-center">
        <n-spin size="small" />
        <span class="upd-muted">正在检查更新…</span>
      </div>

      <!-- 检查/下载/安装失败 -->
      <template v-else-if="s.phase === 'error'">
        <n-alert type="error" :title="s.error || '更新失败'" :bordered="false">
          <span class="upd-muted">{{ s.errorCode ? '错误码 ' + s.errorCode : '可以重试，或到发布页手动下载安装包' }}</span>
        </n-alert>
        <div class="upd-actions">
          <n-button type="primary" @click="onRetry">重试</n-button>
          <n-button tertiary @click="openReleasePage()">打开发布页</n-button>
        </div>
      </template>

      <!-- 有新版本：版本信息 + 更新日志 -->
      <template v-else-if="hasUpdate && (s.phase === 'details' || s.phase === 'idle')">
        <n-descriptions :column="2" size="small" label-placement="left">
          <n-descriptions-item label="当前版本">{{ currentVersion }}</n-descriptions-item>
          <n-descriptions-item label="最新版本">
            <n-tag type="success" size="small">{{ version }}</n-tag>
          </n-descriptions-item>
        </n-descriptions>
        <div v-if="meta" class="upd-meta">{{ meta }}</div>
        <div class="upd-section-title">更新日志</div>
        <n-scrollbar class="upd-notes-box" style="max-height: 220px">
          <div class="upd-notes">{{ notes || '该版本没有填写更新说明。' }}</div>
        </n-scrollbar>
        <div class="upd-actions">
          <n-button type="primary" :disabled="!s.info?.asset" @click="onDownload">
            {{ s.info?.asset ? '下载并安装' : '无可用安装包' }}
          </n-button>
          <n-button tertiary @click="close">以后再说</n-button>
          <n-button text @click="onIgnore">忽略此版本</n-button>
          <n-button text type="primary" @click="openReleasePage()">在 GitHub 查看</n-button>
        </div>
      </template>

      <!-- 下载中：实时进度 -->
      <template v-else-if="s.phase === 'downloading'">
        <div class="upd-center">
          <span class="upd-version">{{ version }}</span>
          <span class="upd-muted">正在下载安装包…</span>
        </div>
        <n-progress type="line" :percentage="s.percent" :height="10" :show-indicator="false" />
        <div class="upd-progress-meta">
          <span>{{ formatBytes(s.received) }} / {{ s.total ? formatBytes(s.total) : '大小未知' }}</span>
          <span v-if="s.speed">{{ formatBytes(s.speed) }}/s</span>
          <span v-if="eta" class="upd-muted">{{ eta }}</span>
        </div>
        <div class="upd-actions">
          <n-button tertiary @click="close">后台下载</n-button>
        </div>
      </template>

      <!-- 已下载：确认后安装 -->
      <template v-else-if="s.phase === 'ready'">
        <n-alert type="success" :bordered="false" title="安装包已下载完成">
          安装程序会关闭当前应用并安装 {{ version }}，安装完成后会自动重新打开。
        </n-alert>
        <div class="upd-actions">
          <n-button type="primary" @click="onInstall">立即安装并重启</n-button>
          <n-button tertiary @click="close">稍后</n-button>
          <n-button text @click="onSnooze">24 小时后再提醒</n-button>
        </div>
      </template>

      <!-- 安装中 -->
      <div v-else-if="s.phase === 'installing'" class="upd-center">
        <n-spin size="small" />
        <span class="upd-muted">正在启动安装程序，应用即将退出，安装完成后会自动重新打开…</span>
      </div>

      <!-- 已是最新 -->
      <template v-else>
        <n-empty size="small" description="当前已是最新版本">
          <template #extra>
            <span class="upd-muted">{{ currentVersion ? '版本 ' + currentVersion : '' }}</span>
          </template>
        </n-empty>
        <div class="upd-actions">
          <n-button type="primary" @click="checkUpdate({ interactive: true })">重新检查</n-button>
        </div>
      </template>
    </div>
  </n-modal>
</template>

<style scoped>
.upd-modal {
  max-width: calc(100vw - 32px);
}
.upd-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.upd-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 0;
}
.upd-meta {
  text-align: left;
}
.upd-section-title {
  text-align: left;
}
.upd-notes-box {
  max-height: 220px;
}
.upd-notes {
  white-space: pre-wrap;
  word-break: break-word;
  padding-right: 8px;
}
.upd-progress-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.upd-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.upd-version {
  font-weight: 700;
}
</style>
