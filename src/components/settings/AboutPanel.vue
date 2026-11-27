<script setup lang="ts">
import SectionTitle from '@/components/settings/SectionTitle.vue'
import BrandMark from '@/components/BrandMark.vue'
import { computed, onMounted, ref } from 'vue'
import { NCard, NButton, NTag, NModal, NDescriptions, NDescriptionsItem, NAlert, NList, NListItem, NProgress, NSwitch, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { checkUpdate, formatBytes, ignoreUpdateVersion, initUpdate, restoreUpdateNotice, updatePrefsSnapshot, updateState } from '@/composables/useUpdate'
import { useAppStore } from '@/stores/app'

const message = useMessage()
const store = useAppStore()
const s = updateState()
const prefs = updatePrefsSnapshot
const info = ref<{ version: string; userData: string; db: string } | null>(null)
const showLicense = ref(false)

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

const lastCheckText = computed(() => {
  const at = Number(s.info?.checkedAt) || 0
  if (!at) return ''
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return '上次检查 ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
})

const downloading = computed(() => s.phase === 'downloading')

onMounted(async () => {
  if (!hasBridge()) return
  void initUpdate()
  try {
    info.value = await call(() => bridge().system.info(), null)
  } catch (e) {
    log.exception('settings.about', e)
  }
})

// 打开全局更新弹窗：里面显示版本信息与更新日志，确认后才开始下载
async function onCheck() {
  if (!hasBridge()) {
    message.warning('检查更新需要在桌面应用内运行')
    return
  }
  s.visible = true
  const res = await checkUpdate({ interactive: true })
  if (!res) return
  if (res.hasUpdate) message.info('发现新版本 ' + res.latest + '，确认后可下载安装')
  else if (res.noRelease) message.info('仓库还没有发布版本')
  else message.success('已是最新版本 ' + versionText.value)
}

/** 自动检查开关：偏好写进 settings.update，主进程按 section 合并，不会抹掉 ignored/snoozeUntil */
async function setAutoCheck(value: boolean) {
  const cur = store.settings?.update
  await store.saveSettings({ update: { ignored: cur?.ignored || '', snoozeUntil: Number(cur?.snoozeUntil) || 0, autoCheck: value } })
}

/** 立刻提醒一次：清掉「稍后提醒」，不改变已忽略的版本 */
async function remindNow() {
  await restoreUpdateNotice()
  message.info('已恢复更新提醒')
}

async function ignoreLatest() {
  await ignoreUpdateVersion(s.info?.latest)
  message.info('已忽略该版本的提示')
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
        <span class="set-muted">Something</span>
      </div>
    </div>

    <p class="set-muted">几件事（Something）是一套纯本地的个人效率工具，无账户体系、无云同步、不含智能功能。</p>

    <n-alert type="info" :bordered="false">
      本应用不提供账户注册与登录；天气、信息流与邮件需要联网，联网结果只做本地缓存。
    </n-alert>

    <SectionTitle title="运行信息" />
    <n-descriptions :column="1" label-placement="left" size="small">
      <n-descriptions-item label="作者">Joont</n-descriptions-item>
      <n-descriptions-item label="版本号">{{ versionText }}</n-descriptions-item>
      <n-descriptions-item label="数据目录">{{ info?.userData || '未在 Electron 中运行' }}</n-descriptions-item>
      <n-descriptions-item label="数据库文件">{{ info?.db || '—' }}</n-descriptions-item>
      <n-descriptions-item label="技术栈">Electron + Vue 3 + Naive UI + SQLite（better-sqlite3）</n-descriptions-item>
    </n-descriptions>

    <div class="set-actions">
      <n-button size="small" :loading="s.phase === 'checking'" @click="onCheck">检查更新</n-button>
      <n-button size="small" @click="showLicense = true">查看开源许可</n-button>
    </div>

    <SectionTitle title="更新提醒" />
    <div class="set-inline set-inline-between">
      <span>发现新版本时发送通知</span>
      <n-switch :value="prefs.autoCheck" @update:value="setAutoCheck" />
    </div>
    <div v-if="prefs.ignored || prefs.snoozeUntil > Date.now()" class="set-inline set-inline-between">
      <span class="set-muted">
        <template v-if="prefs.ignored">已忽略版本 {{ prefs.ignored }}</template>
        <template v-else>已推迟提醒至 {{ new Date(prefs.snoozeUntil).toLocaleString() }}</template>
      </span>
      <n-button size="tiny" tertiary @click="remindNow">恢复提醒</n-button>
    </div>

    <div v-if="downloading" class="set-update">
      <n-progress type="line" :percentage="s.percent" :height="6" :show-indicator="false" />
      <span class="set-muted">
        正在下载 v{{ s.info?.latest || '' }} · {{ formatBytes(s.received) }} / {{ formatBytes(s.total) }}
        <template v-if="s.speed"> · {{ formatBytes(s.speed) }}/s</template>
      </span>
      <n-button size="tiny" tertiary @click="s.visible = true">查看进度</n-button>
    </div>
    <span v-else-if="lastCheckText" class="set-muted">{{ lastCheckText }}</span>

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
