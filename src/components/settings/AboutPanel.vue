<script setup lang="ts">
import SectionTitle from '@/components/settings/SectionTitle.vue'
import BrandMark from '@/components/BrandMark.vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NCard, NButton, NTag, NModal, NDescriptions, NDescriptionsItem, NAlert, NList, NListItem, NProgress, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { UpdateCheckResult, UpdateProgressEvent } from '@/types/api'

const message = useMessage()
const info = ref<{ version: string; userData: string; db: string } | null>(null)
const showLicense = ref(false)
const checking = ref(false)

// 版本号唯一来源：package.json 的 version，运行时由主进程 app.getVersion() 返回
const versionText = computed(() => (info.value?.version ? 'v' + info.value.version : '未在 Electron 中运行'))

const LICENSES = [
  { name: 'Vue 3', license: 'MIT' },
  { name: 'Vue Router', license: 'MIT' },
  { name: 'Pinia', license: 'MIT' },
  { name: 'Naive UI', license: 'MIT' },
  { name: 'better-sqlite3', license: 'MIT' },
  { name: 'zod', license: 'MIT' },
  { name: 'Electron', license: 'MIT' }
]

// 自动更新状态：下载进度由主进程 update:progress 推送，本组件只负责显示
type Phase = 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
const phase = ref<Phase>('idle')
const percent = ref(0)
const updateVersion = ref('')
const updateError = ref('')

const busy = computed(() => phase.value === 'downloading' || phase.value === 'installing')
const progressStatus = computed<'default' | 'success' | 'error'>(() => {
  if (phase.value === 'error') return 'error'
  if (phase.value === 'installing') return 'success'
  return 'default'
})
const progressText = computed(() => {
  if (phase.value === 'downloading') return '正在下载 v' + updateVersion.value + ' · ' + percent.value + '%'
  if (phase.value === 'ready') return '下载完成，正在启动安装 v' + updateVersion.value
  if (phase.value === 'installing') return '正在安装 v' + updateVersion.value + '，应用会自动重启'
  if (phase.value === 'error') return '更新失败：' + updateError.value
  return ''
})

let offProgress: (() => void) | null = null

onMounted(async () => {
  if (!hasBridge()) return
  try {
    info.value = await call(() => bridge().system.info(), null)
  } catch (e) {
    log.exception('settings.about', e)
  }
  // 先订阅再读快照：下载完成的那一瞬间也不会漏掉 ready 事件
  offProgress = bridge().onUpdateProgress(applyProgress)
  try {
    const st: UpdateProgressEvent | null = await call(() => bridge().system.updateStatus(), null)
    if (st && st.state !== 'idle') applyProgress(st)
  } catch (e) {
    log.exception('settings.about.updateStatus', e)
  }
})

onUnmounted(() => {
  if (offProgress) offProgress()
})

// 下载结束直接装机：安装程序由主进程分离启动，随后应用退出
async function installNow() {
  if (!hasBridge()) return
  try {
    await call(() => bridge().system.installUpdate(), false)
  } catch (e) {
    phase.value = 'error'
    updateError.value = (e as Error).message || '安装程序启动失败'
    log.exception('settings.about.install', e)
  }
}

function applyProgress(p: UpdateProgressEvent) {
  if (!p) return
  if (p.version) updateVersion.value = p.version
  if (p.state === 'downloading') {
    phase.value = 'downloading'
    percent.value = Math.max(0, Math.min(100, Number(p.percent) || 0))
    return
  }
  if (p.state === 'ready') {
    phase.value = 'ready'
    percent.value = 100
    void installNow()
    return
  }
  if (p.state === 'installing') {
    phase.value = 'installing'
    percent.value = 100
    return
  }
  if (p.state === 'error') {
    phase.value = 'error'
    updateError.value = p.message || '下载失败'
    return
  }
  phase.value = 'idle'
}

// 检查更新：有新版本立即下载（进度显示在按钮下方），下载完自动安装；
// 没有安装包或开发态无法自动安装时，回落到打开发布页手动下载。
async function checkUpdate() {
  if (!hasBridge()) {
    message.warning('检查更新需要在桌面应用内运行')
    return
  }
  if (checking.value || busy.value) return
  checking.value = true
  try {
    const res: UpdateCheckResult | null = await call(() => bridge().system.checkUpdate(), null)
    if (!res) {
      message.warning('未取到版本信息')
      return
    }
    if (!res.hasUpdate) {
      if (res.noRelease) {
        message.info('当前版本 ' + versionText.value + '，仓库还没有发布版本')
        await call(() => bridge().system.openExternal({ url: res.url }), false)
      } else {
        message.success('已是最新版本 ' + versionText.value)
      }
      return
    }
    updateVersion.value = res.latest || ''
    updateError.value = ''
    percent.value = 0
    phase.value = 'downloading'
    const started = await call(() => bridge().system.downloadUpdate(), { started: false, hasUpdate: false, version: null })
    if (!started.started) {
      phase.value = 'idle'
      if (started.noAsset) {
        message.warning('v' + res.latest + ' 没有附带安装包，正在打开发布页')
        await call(() => bridge().system.openExternal({ url: res.url }), false)
      } else {
        message.success('已是最新版本')
      }
    }
  } catch (e) {
    log.exception('settings.about.update', e)
    const code = (e as Error & { code?: string }).code
    if (code === 'NOT_PACKAGED') {
      phase.value = 'idle'
      message.info('开发模式不自动安装，正在打开发布页')
      try {
        await call(() => bridge().system.openExternal({ url: 'https://github.com/LijunTong/Something/releases' }), false)
      } catch (err) {
        log.exception('settings.about.openRelease', err)
      }
    } else {
      phase.value = 'error'
      updateError.value = (e as Error).message || '网络不可达或 GitHub 接口异常'
      message.error('自动更新失败：' + updateError.value)
    }
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <n-card size="small" title="关于">
    <template #header-extra>
      <n-tag size="small" type="success">{{ versionText }}</n-tag>
    </template>

    <div class="set-about">
      <span class="brand-mark set-about-mark"><BrandMark /></span>
      <div>
        <h2 class="set-about-title">几件事</h2>
        <span class="set-muted">Something · 版本 {{ versionText }}（本地构建）</span>
      </div>
    </div>

    <p class="set-muted">几件事（Something）是一套纯本地的个人效率工具，无账户体系、无云同步、不含智能功能。</p>

    <n-alert type="info" :bordered="false">
      本应用不提供账户注册与登录；天气、快递、信息流与邮件需要联网，联网结果只做本地缓存。
    </n-alert>

    <SectionTitle title="运行信息" />
    <n-descriptions :column="1" label-placement="left" size="small">
      <n-descriptions-item label="版本号">{{ versionText }}</n-descriptions-item>
      <n-descriptions-item label="数据目录">{{ info?.userData || '未在 Electron 中运行' }}</n-descriptions-item>
      <n-descriptions-item label="数据库文件">{{ info?.db || '—' }}</n-descriptions-item>
      <n-descriptions-item label="作者">Joont</n-descriptions-item>
      <n-descriptions-item label="技术栈">Electron + Vue 3 + Naive UI + SQLite（better-sqlite3）</n-descriptions-item>
    </n-descriptions>

    <div class="set-actions">
      <n-button size="small" :loading="checking || phase === 'downloading'" :disabled="phase === 'installing'" @click="checkUpdate">
        {{ phase === 'downloading' ? '正在下载…' : '检查更新' }}
      </n-button>
      <n-button size="small" @click="showLicense = true">查看开源许可</n-button>
    </div>

    <div v-if="phase !== 'idle'" class="set-update">
      <n-progress
        type="line"
        :percentage="percent"
        :status="progressStatus"
        :height="6"
        :show-indicator="phase === 'downloading' || phase === 'error'"
      />
      <span class="set-muted">{{ progressText }}</span>
    </div>

    <n-modal v-model:show="showLicense" preset="card" title="开源许可" class="set-modal" :bordered="false">
      <n-list>
        <n-list-item v-for="l in LICENSES" :key="l.name">
          <div class="set-inline set-inline-between">
            <span>{{ l.name }}</span>
            <n-tag size="tiny">{{ l.license }}</n-tag>
          </div>
        </n-list-item>
      </n-list>
    </n-modal>
  </n-card>
</template>
