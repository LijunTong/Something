<!-- 快递数据源面板：选择接口、保存凭据、自动刷新与连接测试（嵌在快递页右侧抽屉里） -->
<script setup lang="ts">
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { computed, onMounted, ref } from 'vue'
import {
  NCard, NSelect, NInput, NButton, NSwitch, NTag, NAlert,
  NDescriptions, NDescriptionsItem, useMessage
} from 'naive-ui'
import { call, bridge, hasBridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useSettings } from '@/composables/useSettings'
import type { ParcelProvider, ParcelSetting, ParcelTestResult } from '@/types/api'

const props = defineProps<{ embedded?: boolean }>()
const { settings, save, load } = useSettings()
const message = useMessage()

const providers = ref<ParcelProvider[]>([])
const savingCred = ref(false)
const revealing = ref(false)
const testing = ref(false)
const testResult = ref<ParcelTestResult | null>(null)
/** 凭据表单：{ 数据源id: { 字段key: 本次输入的明文 } }，保存成功后清空 */
const credForm = ref<Record<string, Record<string, string>>>({})
/** 测试用单号与手机号后四位：只有顺丰等少数公司需要后四位，留空即可 */
const testNo = ref('')
const testPhone = ref('')

const currentProvider = computed(() => String(settings.value.parcel?.provider || 'manual'))
const active = computed<ParcelProvider | null>(() => providers.value.find((p) => p.id === currentProvider.value) || null)
const currentId = computed(() => (active.value ? active.value.id : ''))
const providerOptions = computed(() => providers.value.map((p) => ({
  label: p.configured ? p.name : p.name + '（未配置凭据）',
  value: p.id
})))
const refreshOptions = [
  { label: '关闭自动刷新', value: 0 },
  { label: '每 30 分钟', value: 30 },
  { label: '每 1 小时', value: 60 },
  { label: '每 3 小时', value: 180 },
  { label: '每 6 小时', value: 360 },
  { label: '每 12 小时', value: 720 }
]
const activeFields = computed(() => (active.value ? active.value.fields : []))
const activeHints = computed(() => (active.value ? active.value.hints : {} as Record<string, string>))

/** 取本次输入的明文；没输入时返回空串，交给 placeholder 显示已保存的掩码尾号 */
function fieldValue(id: string, key: string) {
  const f = credForm.value[id]
  return f ? String(f[key] || '') : ''
}
function setFieldValue(id: string, key: string, v: string) {
  if (!credForm.value[id]) credForm.value[id] = {}
  credForm.value[id][key] = v
}
function fieldPlaceholder(field: ParcelProvider['fields'][number]) {
  const hint = activeHints.value[field.key]
  if (hint) return '已保存（' + hint + '），粘贴新值可覆盖'
  return field.placeholder
}

async function refreshProviders() {
  providers.value = await call(() => bridge().parcel.providers(), [] as ParcelProvider[])
}

async function patch(p: Partial<ParcelSetting>) {
  try {
    await save('parcel', { ...settings.value.parcel, ...p })
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

/** 切数据源：设置里记住选择；对方凭据没配齐时直接提示下一步，不等到刷新才报错 */
async function pickProvider(id: string) {
  if (id === currentProvider.value) return
  await patch({ provider: id })
  await refreshProviders()
  const picked = providers.value.find((p) => p.id === id)
  if (!picked) return
  if (picked.id === 'manual') message.success('已切到手动维护：刷新不会调用接口')
  else if (!picked.configured) message.warning('已切到 ' + picked.name + '，还需要填完下面的凭据才能查询')
  else message.success('已切到 ' + picked.name)
}

async function saveCredential() {
  const p = active.value
  if (!p || p.id === 'manual') return
  const providerId = p.id
  const values = credForm.value[providerId] || {}
  const missing = p.fields.filter((f) => !String(values[f.key] || '').trim() && p.filled.indexOf(f.key) < 0)
  if (missing.length) {
    message.warning('还需要填：' + missing.map((f) => f.label).join('、'))
    return
  }
  if (!Object.keys(values).length) {
    message.warning('没有要保存的内容')
    return
  }
  savingCred.value = true
  try {
    await call(() => bridge().settings.setParcelCredential(plain({ provider: providerId, values })))
    // 返回的只是凭据状态位，避免整段 parcel 设置被覆盖，统一重拉一次设置
    await load(true)
    credForm.value[providerId] = {}
    await refreshProviders()
    message.success(p.name + ' 凭据已明文保存在本机（界面默认掩码）')
  } catch (e) {
    log.exception('settings.parcelCredential', e)
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  } finally {
    savingCred.value = false
  }
}

/** 明文回显：默认掩码，用户点「显示已保存」时把库里的明文填进输入框 */
async function revealCredential() {
  const p = active.value
  if (!p || p.id === 'manual') return
  const providerId = p.id
  revealing.value = true
  try {
    const r = await call(() => bridge().settings.revealParcelCredential({ provider: providerId }), null as unknown as { provider: string; values: Record<string, string> } | null)
    const values = r && r.values ? r.values : {}
    if (!Object.keys(values).length) { message.warning('本机没有保存 ' + p.name + ' 的凭据'); return }
    credForm.value[providerId] = { ...values }
    message.success('已填入明文，输入框右侧的眼睛可切换显示，改完记得再保存')
  } catch (e) {
    log.exception('settings.revealParcelCredential', e)
    message.error('读取失败：' + ((e as Error).message || '未知错误'))
  } finally {
    revealing.value = false
  }
}

async function clearCredential() {
  const p = active.value
  if (!p || p.id === 'manual') return
  const providerId = p.id
  try {
    await call(() => bridge().settings.clearParcelCredential({ provider: providerId }))
    await load(true)
    credForm.value[providerId] = {}
    await refreshProviders()
    message.success('已清除 ' + p.name + ' 的凭据')
  } catch (e) {
    log.exception('settings.clearParcelCredential', e)
    message.error('清除失败：' + ((e as Error).message || '未知错误'))
  }
}

async function test() {
  const p = active.value
  if (!p) return
  if (p.id === 'manual') { message.warning('手动维护模式不调用任何接口'); return }
  if (!testNo.value.trim()) { message.warning('填一个真实的快递单号再测试'); return }
  testing.value = true
  try {
    testResult.value = await call(() => bridge().parcel.testProvider(plain({
      provider: p.id,
      no: testNo.value.trim(),
      phoneTail: testPhone.value.trim() || undefined,
      values: credForm.value[p.id] || {}
    })), null as unknown as ParcelTestResult)
  } catch (e) {
    log.exception('parcel.testProvider', e)
    message.error('测试失败：' + ((e as Error).message || '未知错误'))
  } finally {
    testing.value = false
  }
}

async function openSite() {
  const p = active.value
  if (!p || !p.site) return
  try { await call(() => bridge().system.openExternal({ url: p.site }), false) } catch (e) { log.exception('parcel.openSite', e) }
}

onMounted(async () => {
  if (!hasBridge()) return
  // 面板可能挂在快递页抽屉里，先拉一次最新设置，避免显示旧的选中数据源
  await load(true)
  try { await refreshProviders() } catch (e) { log.exception('parcel.providers', e) }
})
</script>

<template>
  <n-card size="small" :title="props.embedded ? '当前数据源' : '快递数据源'">
    <template #header-extra>
      <n-tag size="small" :type="active && active.configured ? 'success' : 'warning'">
        {{ active ? (active.id === 'manual' ? '手动维护' : active.configured ? '已配置' : '待配置') : '读取中' }}
      </n-tag>
    </template>

    <n-alert type="info" :bordered="false">
      轨迹只来自真实物流接口：选好数据源并保存凭据后，刷新包裹才会真的去查；手动维护模式不生成任何本地模拟轨迹。
      凭据明文保存在本机数据库，界面默认掩码，需要时点「显示已保存」。
    </n-alert>

    <SectionTitle title="数据源" />
    <div class="set-field">
      <span class="set-field-key">物流接口</span>
      <n-select
        class="set-select-wide"
        size="small"
        :value="currentProvider"
        :options="providerOptions"
        @update:value="(v: string) => pickProvider(v)"
      />
    </div>
    <p v-if="active" class="set-muted">{{ active.desc }}</p>
    <div v-if="active && active.site" class="set-actions">
      <n-button size="small" quaternary @click="openSite">打开 {{ active.name }} 官网</n-button>
      <span class="set-muted">{{ active.site }}</span>
    </div>

    <template v-if="active && active.id !== 'manual'">
      <SectionTitle title="凭据" />
      <div v-for="field in activeFields" :key="field.key" class="set-field">
        <span class="set-field-key">{{ field.label }}</span>
        <n-input
          class="set-input-wide"
          size="small"
          :type="field.secret ? 'password' : 'text'"
          :show-password-on="field.secret ? 'click' : undefined"
          :value="fieldValue(currentId, field.key)"
          :placeholder="fieldPlaceholder(field)"
          @update:value="(v: string) => setFieldValue(currentId, field.key, v)"
        />
      </div>
      <p class="set-muted">
        快递100 的 customer 是授权信息里的「客户编号」；快递鸟的 EBusinessID 在用户中心可见；聚合数据用申请到的 key。
        凭据只保存在本机。
      </p>
      <div class="set-actions">
        <n-button size="small" type="primary" :loading="savingCred" @click="saveCredential">保存凭据</n-button>
        <n-button size="small" :disabled="!active.filled.length" :loading="revealing" @click="revealCredential">显示已保存</n-button>
        <n-button size="small" :disabled="!active.filled.length" @click="clearCredential">清除</n-button>
      </div>
    </template>
    <n-alert v-else-if="active" type="warning" :bordered="false" class="set-result">
      手动维护模式：包裹状态与取件码由你在详情里自己维护，刷新只重读本地数据，不会调用任何接口。
    </n-alert>

    <SectionTitle title="刷新" />
    <div class="set-field">
      <span class="set-field-key">自动刷新</span>
      <n-select
        class="set-select"
        size="small"
        :value="settings.parcel.autoRefreshMin"
        :options="refreshOptions"
        @update:value="(v: number) => patch({ autoRefreshMin: v })"
      />
    </div>
    <div class="set-field">
      <span class="set-field-key">按单号自动识别公司</span>
      <n-switch :value="settings.parcel.detectCompany" @update:value="(v: boolean) => patch({ detectCompany: v })" />
    </div>
    <p class="set-muted">自动刷新只查未签收的包裹；顺丰等少数公司要手机号后四位，在包裹详情里补填即可。</p>

    <SectionTitle title="连接测试" />
    <div class="set-field">
      <span class="set-field-key">测试单号</span>
      <div class="set-inline">
        <n-input class="set-input" size="small" :value="testNo" placeholder="填一个真实的快递单号" @update:value="(v: string) => (testNo = v)" />
        <n-input class="set-input" size="small" :value="testPhone" placeholder="手机号后四位（可选）" @update:value="(v: string) => (testPhone = v)" />
      </div>
    </div>
    <div class="set-actions">
      <n-button size="small" type="primary" :loading="testing" :disabled="!active || active.id === 'manual'" @click="test">测试连接</n-button>
      <span class="set-muted">会真实调用一次接口，不写库</span>
    </div>
    <n-descriptions v-if="testResult" :column="1" label-placement="left" size="small" class="set-result">
      <n-descriptions-item label="结果">
        <n-tag size="small" :type="testResult.ok ? 'success' : 'warning'">{{ testResult.ok ? '通过' : '失败' }}</n-tag>
      </n-descriptions-item>
      <n-descriptions-item label="说明">{{ testResult.message }}</n-descriptions-item>
      <n-descriptions-item v-if="testResult.company" label="识别公司">{{ testResult.company }}</n-descriptions-item>
      <n-descriptions-item v-if="testResult.status" label="包裹状态">{{ testResult.status }}</n-descriptions-item>
      <n-descriptions-item label="错误码">{{ testResult.code }}</n-descriptions-item>
    </n-descriptions>
  </n-card>
</template>

