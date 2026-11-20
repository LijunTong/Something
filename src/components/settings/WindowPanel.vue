<script setup lang="ts">
// 窗口与启动：关闭/最小化到托盘、开机启动。开关立即生效，同时写入设置。
import { onMounted, ref } from 'vue'
import { NCard, NSwitch, NTag, useMessage } from 'naive-ui'
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useSettings } from '@/composables/useSettings'
import type { WindowSetting } from '@/types/api'

const { settings, save, load } = useSettings()
const message = useMessage()
/** 托盘对象是否真的创建成功（失败时图标不会出现，需要提示用户） */
const trayAlive = ref<boolean | null>(null)

async function patch(p: Partial<WindowSetting>) {
  try {
    await save('window', { ...settings.value.window, ...p })
  } catch (e) {
    log.exception('settings.window', e)
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function locateTray() {
  const ok = await call(() => bridge().system.trayHint(), false)
  message[ok ? 'info' : 'warning'](ok ? '已发送托盘提示，如果仍看不到请检查任务栏 ^ 展开区' : '托盘未就绪，请重启应用后再试')
}

async function probeTray() {
  const ok = await call(() => bridge().system.trayProbe(), false)
  if (!ok) { message.warning('托盘自检不可用，请重启应用后再试'); return }
  message.info('窗口已隐藏：请到任务栏托盘（含 ^ 展开区）点击本应用图标；8 秒内无操作会自动恢复')
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
    const tray = await call(() => bridge().system.trayInfo(), null as unknown as { alive: boolean } | null)
    trayAlive.value = !!(tray && tray.alive)
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
      <span class="set-field-key">托盘状态</span>
      <n-tag size="small" :type="trayAlive === false ? 'error' : 'success'">
        {{ trayAlive === false ? '未创建' : '运行中' }}
      </n-tag>
    </div>
    <p class="set-muted">
      Windows 默认把新托盘图标折叠到任务栏右下角的 <strong>^</strong> 展开区里；没直接看到图标时点一下 ^，
      就能找到「效率工具集」，单击恢复窗口、右键可退出。
      如果系统没有显示托盘图标，点关闭会自动改为「最小化到任务栏」而不是隐藏，避免窗口彻底找不到；
      也可以再次启动应用，单例会把已有窗口唤到前台。
    </p>
    <div class="set-actions">
      <n-button size="small" quaternary @click="locateTray">在托盘显示提示</n-button>
      <n-button size="small" quaternary @click="probeTray">测试托盘（隐藏 8 秒）</n-button>
    </div>
    <p class="set-muted">「测试托盘」会把窗口收进托盘 8 秒：如果你能在托盘点到图标并恢复，说明功能正常；8 秒内没有交互，窗口会自动恢复并提示。</p>
    <div class="set-field">
      <span class="set-field-key">关闭窗口时最小化到托盘</span>
      <n-switch :value="settings.window.closeToTray" @update:value="(v: boolean) => patch({ closeToTray: v })" />
    </div>
    <p class="set-muted">开启后点右上角关闭只会隐藏窗口，应用继续在托盘运行；从托盘菜单「退出」才会真正结束进程。</p>
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
