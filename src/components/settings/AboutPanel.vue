<script setup lang="ts">
import SectionTitle from '@/components/settings/SectionTitle.vue'
import BrandMark from '@/components/BrandMark.vue'
import { computed, onMounted, ref } from 'vue'
import { NCard, NButton, NTag, NModal, NDescriptions, NDescriptionsItem, NAlert, NList, NListItem, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { UpdateCheckResult } from '@/types/api'

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

onMounted(async () => {
  if (!hasBridge()) return
  try {
    info.value = await call(() => bridge().system.info(), null)
  } catch (e) {
    log.exception('settings.about', e)
  }
})

// 检查更新：主进程读 GitHub 最新正式发布并与当前版本比对；
// 有新版直接打开该版本的发布页，没有就提示已是最新。
async function checkUpdate() {
  if (!hasBridge()) {
    message.warning('检查更新需要在桌面应用内运行')
    return
  }
  if (checking.value) return
  checking.value = true
  try {
    const res: UpdateCheckResult | null = await call(() => bridge().system.checkUpdate(), null)
    if (!res) {
      message.warning('未取到版本信息')
      return
    }
    if (res.hasUpdate) {
      message.success('发现新版本 v' + res.latest + '，正在打开 GitHub 发布页')
      await call(() => bridge().system.openExternal({ url: res.url }), false)
    } else if (res.noRelease) {
      message.info('当前版本 ' + versionText.value + '，仓库还没有发布版本')
      await call(() => bridge().system.openExternal({ url: res.url }), false)
    } else {
      message.success('已是最新版本 ' + versionText.value)
    }
  } catch (e) {
    log.exception('settings.about.update', e)
    message.error('检查更新失败：网络不可达或 GitHub 接口异常，请稍后再试')
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
      <n-button size="small" :loading="checking" @click="checkUpdate">检查更新</n-button>
      <n-button size="small" @click="showLicense = true">查看开源许可</n-button>
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
