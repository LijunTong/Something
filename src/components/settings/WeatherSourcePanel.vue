<!-- 天气面板：模块启用开关 + 数据源/凭据/缓存配置（原「天气」与「天气数据源」两个面板已合并） -->
<script setup lang="ts">
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { computed, onMounted, ref, watch } from 'vue'
import {
  NCard, NSelect, NInput, NButton, NSwitch, NTag, NAlert, NDescriptions, NDescriptionsItem, useMessage
} from 'naive-ui'
import { call, bridge, hasBridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useSettings } from '@/composables/useSettings'
import type { WeatherCity, WeatherSetting, WeatherTestResult } from '@/types/api'

const props = defineProps<{ embedded?: boolean }>()
const { settings, save, load } = useSettings()
const message = useMessage()

const keyInput = ref('')
const savingKey = ref(false)
/** JWT 凭据：私钥只提交给主进程加密保存，不回显 */
const jwtForm = ref({ developerId: '', projectId: '', keyId: '', privateKey: '' })
/** 已保存的凭据信息（开发者/项目/凭据 ID 非密钥，可回显；私钥只显示「已保存」） */
watch(() => settings.value.weather.jwtMeta, (meta) => {
  if (!meta) return
  jwtForm.value.developerId = meta.developerId || jwtForm.value.developerId
  jwtForm.value.projectId = meta.projectId || jwtForm.value.projectId
  jwtForm.value.keyId = meta.keyId || jwtForm.value.keyId
}, { immediate: true, deep: true })
const apiKeyHintText = computed(() => settings.value.weather.apiKeySet
  ? '已保存（尾号 ' + (settings.value.weather.apiKeyHint || '****') + '），粘贴新 Key 可覆盖'
  : '粘贴 API Key 后保存')
const savingJwt = ref(false)
const authModeText = computed(() => {
  const mode = settings.value.weather.authMode
  if (mode === 'jwt') return 'JWT 已配置'
  if (mode === 'key') return 'API Key 已配置'
  return '未配置认证'
})
const authModeType = computed(() => (settings.value.weather.authMode === 'none' ? 'warning' : 'success'))
const testing = ref(false)
const testResult = ref<WeatherTestResult | null>(null)
const cities = ref<WeatherCity[]>([])

/** 认证方式二选一：JWT（推荐）或 API Key；只显示选中的那套配置 */
const authTypeOptions = [
  { label: 'JWT（推荐）', value: 'jwt' },
  { label: 'API Key（兼容）', value: 'key' }
]
const authType = ref<'jwt' | 'key'>('jwt')
watch(() => settings.value.weather.authType, (v) => {
  if (v === 'jwt' || v === 'key') authType.value = v
}, { immediate: true })
watch(() => settings.value.weather.authMode, (mode) => {
  if (!settings.value.weather.authType) authType.value = mode === 'key' ? 'key' : 'jwt'
}, { immediate: true })
async function setAuthType(v: 'jwt' | 'key') {
  authType.value = v
  await patch({ authType: v })
}
/** API Host：和风天气新版账号在控制台会分配专属 Host，这里允许手填；旧账号用公共域名 */
const hostInput = ref('')
const geoHostInput = ref('')
/** 和风天气 2024 起停用公共域名，只认控制台分配的账号专属 Host */
const LEGACY_HOSTS = ['api.qweather.com', 'devapi.qweather.com', 'geoapi.qweather.com']
const hostIsLegacy = computed(() => LEGACY_HOSTS.indexOf(String(settings.value.weather.host || '').trim()) >= 0)

watch(() => settings.value.weather.host, (v) => { hostInput.value = v || '' }, { immediate: true })
watch(() => settings.value.weather.geoHost, (v) => { geoHostInput.value = v || '' }, { immediate: true })

async function openConsole() {
  try { await call(() => bridge().system.openExternal({ url: 'https://console.qweather.com/' }), false) } catch (e) { log.exception('settings.qweatherConsole', e) }
}
async function saveHost() {
  const v = hostInput.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!v) { hostInput.value = settings.value.weather.host; return }
  if (v !== settings.value.weather.host) { await patch({ host: v }); message.success('API Host 已更新') }
}
async function saveGeoHost() {
  const v = geoHostInput.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!v) { geoHostInput.value = settings.value.weather.geoHost; return }
  if (v !== settings.value.weather.geoHost) { await patch({ geoHost: v }); message.success('城市搜索 Host 已更新') }
}
async function saveJwt() {
  const f = jwtForm.value
  if (!f.developerId.trim() || !f.projectId.trim() || !f.keyId.trim()) {
    message.warning('开发者 ID、项目 ID、凭据 ID 都要填')
    return
  }
  // 私钥不回显：编辑已有凭据时留空表示沿用原私钥，首次配置必须填
  if (!f.privateKey.trim() && !settings.value.weather.jwtSet) {
    message.warning('首次配置需要粘贴 Ed25519 私钥')
    return
  }
  savingJwt.value = true
  try {
    const next = await call(() => bridge().settings.setWeatherJwt(plain({
      developerId: f.developerId.trim(),
      projectId: f.projectId.trim(),
      keyId: f.keyId.trim(),
      privateKey: f.privateKey.trim() || undefined
    })), null as unknown as WeatherSetting)
    if (next) await save('weather', next)
    jwtForm.value.privateKey = ''
    message.success('JWT 凭据已加密保存在本机，可直接点「测试连接」验证')
  } catch (e) {
    log.exception('settings.weatherJwt', e)
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  } finally {
    savingJwt.value = false
  }
}

async function clearJwt() {
  try {
    const next = await call(() => bridge().settings.clearWeatherJwt(), null as unknown as WeatherSetting)
    if (next) await save('weather', next)
    message.success('已清除 JWT 凭据')
  } catch (e) {
    log.exception('settings.weatherJwt.clear', e)
    message.error('清除失败：' + ((e as Error).message || '未知错误'))
  }
}

async function openDocs() {
  try { await call(() => bridge().system.openExternal({ url: 'https://dev.qweather.com/docs/api/' }), false) } catch (e) { log.exception('settings.qweatherDocs', e) }
}
const refreshOptions = [1, 5, 10, 30].map((n) => ({ label: '每 ' + n + ' 分钟', value: n }))

const homeCity = computed(() => cities.value.find((c) => c.home) || cities.value[0] || null)
/** 模块启用开关原本是独立的「天气」面板，现合并到天气面板顶部 */
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
  // 面板可能是在设置页之外（天气抽屉）挂载的，先拉一次最新设置
  await load(true)
  try {
    cities.value = await call(() => bridge().weather.cities(), [] as WeatherCity[])
  } catch (e) {
    log.exception('settings.weatherCities', e)
  }
})
</script>

<template>
  <n-card size="small" :title="props.embedded ? undefined : '天气数据源'">
    <template #header-extra>
      <n-tag size="small" :type="authModeType">{{ authModeText }}</n-tag>
    </template>

    <n-alert type="info" :bordered="false">
      天气与预警由和风天气获取；JWT 私钥或 API Key 经系统加密后仅保存在本机。界面会回显开发者 ID / 项目 ID / 凭据 ID 与 Key 尾号，私钥不回显。
    </n-alert>

    <SectionTitle title="数据源" />
    <n-alert v-if="hostIsLegacy" type="error" :bordered="false" class="set-result">
      当前填写的是已停用的公共域名，请改成控制台分配的账号专属 Host（形如 abcxyz.re.qweatherapi.com）。
    </n-alert>
    <n-alert v-else-if="!settings.weather.host" type="warning" :bordered="false" class="set-result">
      还没有配置 API Host：请到和风天气控制台创建项目，复制 API Host 与 API Key 填到下面。
    </n-alert>
    <div class="set-field">
      <span class="set-field-key">API Host</span>
      <n-input
        class="set-input-wide"
        size="small"
        :value="hostInput"
        placeholder="例如 devapi.qweather.com 或 abcxyz.re.qweatherapi.com"
        @update:value="(v: string) => (hostInput = v)"
        @blur="saveHost"
      />
    </div>
    <div class="set-field">
      <span class="set-field-key">城市搜索 Host（可选）</span>
      <n-input
        class="set-input-wide"
        size="small"
        :value="geoHostInput"
        placeholder="留空则与上面的 API Host 相同"
        @update:value="(v: string) => (geoHostInput = v)"
        @blur="saveGeoHost"
      />
    </div>
    <SectionTitle title="身份认证" />
    <div class="set-field">
      <span class="set-field-key">认证方式</span>
      <n-select
        class="set-select-wide"
        size="small"
        :value="authType"
        :options="authTypeOptions"
        @update:value="(v: 'jwt' | 'key') => setAuthType(v)"
      />
    </div>

    <div v-if="authType === 'jwt'">
    <p class="set-muted">
      JWT（推荐）：Ed25519 私钥本地签名，请求只带 15 分钟短期 Token，密钥不上传输链路。
      开发者 ID / 项目 ID / 凭据 ID 在控制台「设置 → 开发者信息」与「项目管理」里。
    </p>
    <div class="set-field">
      <span class="set-field-key">开发者 ID（iss）</span>
      <n-input class="set-input-wide" size="small" :value="jwtForm.developerId" placeholder="Q 开头的 10 位开发者 ID" @update:value="(v: string) => (jwtForm.developerId = v)" />
    </div>
    <div class="set-field">
      <span class="set-field-key">项目 ID（sub）</span>
      <n-input class="set-input-wide" size="small" :value="jwtForm.projectId" placeholder="控制台 › 项目管理里的项目 ID" @update:value="(v: string) => (jwtForm.projectId = v)" />
    </div>
    <div class="set-field">
      <span class="set-field-key">凭据 ID（kid）</span>
      <n-input class="set-input-wide" size="small" :value="jwtForm.keyId" placeholder="控制台 › 凭据里的 ID" @update:value="(v: string) => (jwtForm.keyId = v)" />
    </div>
    <div class="set-field">
      <span class="set-field-key">Ed25519 私钥（PEM）</span>
      <n-input
        class="set-input-wide"
        size="small"
        type="textarea"
        :autosize="{ minRows: 4, maxRows: 8 }"
        :placeholder="settings.weather.jwtSet ? '已保存（私钥不回显），留空则沿用原私钥' : '-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----'"
        :value="jwtForm.privateKey"
        @update:value="(v: string) => (jwtForm.privateKey = v)"
      />
    </div>
    <div class="set-actions">
      <n-button size="small" type="primary" :loading="savingJwt" @click="saveJwt">保存 JWT 凭据</n-button>
      <n-button size="small" :disabled="!settings.weather.jwtSet" @click="clearJwt">清除 JWT</n-button>
      <n-button size="small" quaternary @click="openDocs">认证文档</n-button>
    </div>
    </div>

    <div v-else>
    <p class="set-muted">API Key（兼容旧方式）：Key 以 query 参数发送，建议仅在无法使用 JWT 时选择。</p>
    <div class="set-field">
      <span class="set-field-key">API Key</span>
      <div class="set-inline">
        <n-input
          class="set-input"
          size="small"
          type="password"
          show-password-on="click"
          :placeholder="apiKeyHintText"
          :value="keyInput"
          @update:value="(v: string) => (keyInput = v)"
        />
        <n-button size="small" type="primary" :loading="savingKey" @click="saveKey">保存</n-button>
        <n-button size="small" :disabled="!settings.weather.apiKeySet" @click="clearKey">清除</n-button>
      </div>
    </div>
    </div>
    <div class="set-field">
      <span class="set-field-key">定位城市</span>
      <span class="set-field-value">{{ homeCity ? homeCity.name + ' · 自动定位' : '尚未设置，去天气页添加城市' }}</span>
    </div>

    <SectionTitle title="刷新与缓存" />
    <div class="set-field">
      <span class="set-field-key">更新频率</span>
      <n-select
        class="set-select"
        size="small"
        :value="settings.weather.refreshMin || settings.weather.cacheMin || 5"
        :options="refreshOptions"
        @update:value="(v: number) => patch({ refreshMin: v, cacheMin: v })"
      />
    </div>
    <p class="set-muted">
      天气数据始终来自和风天气；本机只保存最近一次成功结果，用于请求失败或断网时兜底，不会拿缓存冒充满新数据。
    </p>
    <div class="set-field">
      <span class="set-field-key">离线使用最近缓存</span>
      <n-switch :value="settings.weather.offlineCache" @update:value="(v: boolean) => patch({ offlineCache: v })" />
    </div>
    <div class="set-field">
      <span class="set-field-key">天气预警本地推送</span>
      <n-switch :value="settings.weather.alertPush" @update:value="(v: boolean) => patch({ alertPush: v })" />
    </div>

    <div class="set-actions">
      <n-button size="small" type="primary" :loading="testing" @click="test">测试连接</n-button>
      <n-button size="small" quaternary @click="openConsole">打开控制台</n-button>
      <n-button size="small" quaternary @click="openDocs">接口文档</n-button>
      <span class="set-muted">会真实调用 GeoAPI 与实时天气接口</span>
    </div>

    <n-descriptions v-if="testResult" :column="1" label-placement="left" size="small" class="set-result">
      <n-descriptions-item label="结果">
        <n-tag size="small" :type="testResult.ok ? 'success' : 'warning'">{{ testResult.ok ? '通过' : '待配置' }}</n-tag>
      </n-descriptions-item>
      <n-descriptions-item label="说明">{{ testResult.message }}</n-descriptions-item>
      <n-descriptions-item v-if="testResult.city" label="测试城市">{{ testResult.city }}</n-descriptions-item>
      <n-descriptions-item v-if="testResult.code" label="错误码">{{ testResult.code }}</n-descriptions-item>
      <n-descriptions-item label="天气 Host">{{ testResult.host }}</n-descriptions-item>
      <n-descriptions-item label="搜索 Host">{{ testResult.geoHost || '—' }}</n-descriptions-item>
      <n-descriptions-item label="缓存">{{ testResult.cacheMin }} 分钟</n-descriptions-item>
    </n-descriptions>
  </n-card>
</template>