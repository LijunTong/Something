<script setup lang="ts">
// 窗口与启动：关闭/最小化到托盘、开机启动。开关立即生效，同时写入设置。
import { onMounted } from 'vue'
import { NCard, NSwitch, NTag, useMessage } from 'naive-ui'
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useSettings } from '@/composables/useSettings'
import type { WindowSetting } from '@/types/api'

const { settings, save, load } = useSettings()
const message = useMessage()

async function patch(p: Partial<WindowSetting>) {
  try {
    await save('window', { ...settings.value.window, ...p })
  } catch (e) {
    log.exception('settings.window', e)
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function toggleLaunch(enabled: boolean) {
  try {
    const applied = await call(() => bridge().system.setLaunchAtLogin({ enabled }), false)
    await patch({ launchAtLogin: !!applied })
    message[applied ? 'success' : 'warning'](applied ? '已' + (enabled ? '开启' : '关闭') + '开机启动' : '系统未接受开机启动设置，已保留选项')
  } catch (e) {
    log.exception('settings.launchAtLogin', e)
    message.error('设置开机启动失败：' + ((e as Error).message || '未知错误'))
  }
}

onMounted(async () => {
  await load(true)
  if (!hasBridge()) return
  try {
    // 以系统登录项为准回填，避免设置与实际状态不一致
    const enabled = await call(() => bridge().system.loginItemEnabled(), false)
    if (enabled !== settings.value.window.launchAtLogin) {
      await save('window', { ...settings.value.window, launchAtLogin: enabled })
    }
  } catch (e) {
    log.exception('settings.window.sync', e)
  }
})
</script>

<template>
  <n-card size="small" title="窗口与启动">
    <template #header-extra><n-tag size="small">立即生效</n-tag></template>

    <SectionTitle title="托盘行为" />
    <div class="set-field">
      <span class="set-field-key">
        关闭窗口时最小化到托盘
        <small class="set-hint">点关闭只隐藏窗口，从托盘菜单「退出」才结束进程</small>
      </span>
      <n-switch :value="settings.window.closeToTray" @update:value="(v: boolean) => patch({ closeToTray: v })" />
    </div>
    <div class="set-field">
      <span class="set-field-key">最小化时隐藏到托盘</span>
      <n-switch :value="settings.window.minimizeToTray" @update:value="(v: boolean) => patch({ minimizeToTray: v })" />
    </div>

    <SectionTitle title="启动" />
    <div class="set-field">
      <span class="set-field-key">开机自动启动</span>
      <n-switch :value="settings.window.launchAtLogin" @update:value="(v: boolean) => toggleLaunch(v)" />
    </div>
    <p class="set-muted">写入系统登录项；开发态注册的是当前 Electron 可执行文件，打包后换成应用自身。</p>
  </n-card>
</template>
