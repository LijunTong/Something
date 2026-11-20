<!-- 天气面板：模块启用开关 + 数据源/凭据/缓存配置（原「天气」与「天气数据源」两个面板已合并） -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NCard, NSelect, NInput, NButton, NSwitch, NTag, NAlert, NDescriptions, NDescriptionsItem, useMessage
} from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useSettings } from '@/composables/useSettings'
import type { ModulesSetting, WeatherCity, WeatherSetting, WeatherTestResult } from '@/types/api'

const { settings, save } = useSettings()
const message = useMessage()

const keyInput = ref('')
const savingKey = ref(false)
const testing = ref(false)
const testResult = ref<WeatherTestResult | null>(null)
const cities = ref<WeatherCity[]>([])

const sourceOptions = [
  { label: '和风天气（QWeather）', value: 'qweather' },
  { label: '备用数据源（本地缓存）', value: 'fallback' }
]
const hostOptions = [
  { label: 'api.qweather.com（正式）', value: 'api.qweather.com' },
  { label: 'devapi.qweather.com（开发）', value: 'devapi.qweather.com' }
]
const cacheOptions = [15, 30, 60, 180].map((n) => ({ label: n + ' 分钟', value: n }))

const homeCity = computed(() => cities.value.find((c) => c.home) || cities.value[0] || null)
/** 模块启用开关原本是独立的「天气」面板，现合并到天气面板顶部 */
const enabled = computed(() => Boolean((settings.value.modules as ModulesSetting).weather))

async function toggleEnabled(v: boolean) {
  const next = { ...settings.value.modules, weather: v } as ModulesSetting
  try {
    await save('modules', next)
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function patch(p: Partial<WeatherSetting>) {
  try {
    await save('weather', { ...settings.value.weather, ...p })
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function saveKey() {
  if (!keyInput.value.trim()) { message.warning('请先填写 API Key'); return }
  savingKey.value = true
  try {
    await call(() => bridge().settings.setWeatherKey({ key: keyInput.value.trim() }))
    keyInput.value = ''
    await save('weather', { ...settings.value.weather, apiKeySet: true })
    message.success('API Key 已加密保存在本机')
  } catch (e) {
    log.exception('settings.weatherKey', e)
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  } finally {
    savingKey.value = false
  }
}

async function clearKey() {
  try {
    await call(() => bridge().settings.setWeatherKey({ key: '' }))
    await save('weather', { ...settings.value.weather, apiKeySet: false })
    message.success('已清除本机保存的 API Key')
  } catch (e) {
    log.exception('settings.weatherKey.clear', e)
    message.error('清除失败：' + ((e as Error).message || '未知错误'))
  }
}

async function test() {
  testing.value = true
  try {
    testResult.value = await call(() => bridge().settings.testWeather(), null as unknown as WeatherTestResult)
  } catch (e) {
    log.exception('settings.testWeather', e)
    message.error('自检失败：' + ((e as Error).message || '未知错误'))
  } finally {
    testing.value = false
  }
}

onMounted(async () => {
  if (!hasBridge()) return
  try {
    cities.value = await call(() => bridge().weather.cities(), [] as WeatherCity[])
  } catch (e) {
    log.exception('settings.weatherCities', e)
  }
})
</script>

<template>
  <n-card size="small" title="天气">
    <template #header-extra>
      <n-tag size="small" :type="enabled ? 'success' : 'default'">{{ enabled ? '已启用' : '已停用' }}</n-tag>
    </template>

    <div class="set-field">
      <span class="set-field-key">启用该模块</span>
      <n-switch :value="enabled" @update:value="toggleEnabled" />
    </div>

    <n-alert type="info" :bordered="false">
      天气与预警由数据源获取；API Key 经系统加密后仅保存在本机，天气结果写入本地缓存，断网时读缓存。
    </n-alert>

    <div class="set-sub">数据源与凭据</div>
    <div class="set-field">
      <span class="set-field-key">数据源</span>
      <n-select
        class="set-select-wide"
        size="small"
        :value="settings.weather.source"
        :options="sourceOptions"
        @update:value="(v: string) => patch({ source: v })"
      />
    </div>
    <div class="set-field">
      <span class="set-field-key">API Host</span>
      <n-select
        class="set-select-wide"
        size="small"
        :value="settings.weather.host"
        :options="hostOptions"
        @update:value="(v: string) => patch({ host: v })"
      />
    </div>
    <div class="set-field">
      <span class="set-field-key">API Key</span>
      <div class="set-inline">
        <n-input
          class="set-input"
          size="small"
          type="password"
          show-password-on="click"
          placeholder="粘贴 API Key 后保存"
          :value="keyInput"
          @update:value="(v: string) => (keyInput = v)"
        />
        <n-button size="small" type="primary" :loading="savingKey" @click="saveKey">保存</n-button>
        <n-button size="small" :disabled="!settings.weather.apiKeySet" @click="clearKey">清除</n-button>
      </div>
    </div>
    <div class="set-field">
      <span class="set-field-key">定位城市</span>
      <span class="set-field-value">{{ homeCity ? homeCity.name + ' · 自动定位' : '尚未设置，去天气页添加城市' }}</span>
    </div>

    <div class="set-sub">缓存与更新</div>
    <div class="set-field">
      <span class="set-field-key">缓存有效期</span>
      <n-select
        class="set-select"
        size="small"
        :value="settings.weather.cacheMin"
        :options="cacheOptions"
        @update:value="(v: number) => patch({ cacheMin: v })"
      />
    </div>
    <div class="set-field">
      <span class="set-field-key">离线使用最近缓存</span>
      <n-switch :value="settings.weather.offlineCache" @update:value="(v: boolean) => patch({ offlineCache: v })" />
    </div>
    <div class="set-field">
      <span class="set-field-key">天气预警本地推送</span>
      <n-switch :value="settings.weather.alertPush" @update:value="(v: boolean) => patch({ alertPush: v })" />
    </div>

    <div class="set-actions">
      <n-button size="small" :loading="testing" @click="test">测试连接</n-button>
      <span class="set-muted">只做本地配置校验，不发起网络请求</span>
    </div>

    <n-descriptions v-if="testResult" :column="1" label-placement="left" size="small" class="set-result">
      <n-descriptions-item label="结果">
        <n-tag size="small" :type="testResult.ok ? 'success' : 'warning'">{{ testResult.ok ? '通过' : '待配置' }}</n-tag>
      </n-descriptions-item>
      <n-descriptions-item label="说明">{{ testResult.message }}</n-descriptions-item>
      <n-descriptions-item label="Host">{{ testResult.host }}</n-descriptions-item>
      <n-descriptions-item label="缓存">{{ testResult.cacheMin }} 分钟</n-descriptions-item>
    </n-descriptions>
  </n-card>
</template>
