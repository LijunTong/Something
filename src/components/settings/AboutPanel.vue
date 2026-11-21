<script setup lang="ts">
import SectionTitle from '@/components/settings/SectionTitle.vue'
import BrandMark from '@/components/BrandMark.vue'
import { onMounted, ref } from 'vue'
import { NCard, NButton, NTag, NModal, NDescriptions, NDescriptionsItem, NAlert, NList, NListItem, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'

const message = useMessage()
const info = ref<{ version: string; userData: string; db: string } | null>(null)
const showLicense = ref(false)

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

function checkUpdate() {
  message.info('当前为本地构建版本，不提供在线更新通道；升级请替换安装包后重启应用。')
}
</script>

<template>
  <n-card size="small" title="关于">
    <template #header-extra><n-tag size="small" type="success">纯本地</n-tag></template>

    <div class="set-about">
      <span class="brand-mark set-about-mark"><BrandMark /></span>
      <div>
        <h2 class="set-about-title">几件事</h2>
        <span class="set-muted">Something · 版本 {{ info?.version || '1.0.0' }}（本地构建）</span>
      </div>
    </div>

    <p class="set-muted">几件事（Something）是一套纯本地的个人效率工具，无账户体系、无云同步、不含智能功能。</p>

    <n-alert type="info" :bordered="false">
      本应用不提供账户注册与登录；天气、快递、信息流与邮件需要联网，联网结果只做本地缓存。
    </n-alert>

    <SectionTitle title="运行信息" />
    <n-descriptions :column="1" label-placement="left" size="small">
      <n-descriptions-item label="数据目录">{{ info?.userData || '未在 Electron 中运行' }}</n-descriptions-item>
      <n-descriptions-item label="数据库文件">{{ info?.db || '—' }}</n-descriptions-item>
      <n-descriptions-item label="作者">Joont</n-descriptions-item>
      <n-descriptions-item label="技术栈">Electron + Vue 3 + Naive UI + SQLite（better-sqlite3）</n-descriptions-item>
    </n-descriptions>

    <div class="set-actions">
      <n-button size="small" @click="checkUpdate">检查更新</n-button>
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