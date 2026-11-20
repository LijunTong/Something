<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import {
  NCard, NButton, NDataTable, NTag, NModal, NForm, NFormItem, NInput, NInputNumber,
  NSelect, NSwitch, NAlert, NEmpty, NSpin, NPopconfirm, useMessage
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { call, bridge, hasBridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { MailAccount } from '@/types/api'

const message = useMessage()
const accounts = ref<MailAccount[]>([])
const loading = ref(false)
const showForm = ref(false)
const editingId = ref<string | null>(null)
const testing = ref(false)
const testText = ref('')

const form = ref({
  alias: '', email: '', protocol: 'imap',
  imapHost: '', imapPort: 993 as number | null,
  smtpHost: '', smtpPort: 465 as number | null,
  username: '', secret: '', syncDays: 30
})

const protocolOptions = [
  { label: 'IMAP', value: 'imap' },
  { label: 'POP3', value: 'pop3' }
]
const syncOptions = [
  { label: '最近 7 天', value: 7 },
  { label: '最近 30 天', value: 30 },
  { label: '最近 90 天', value: 90 },
  { label: '全部邮件', value: 3650 }
]

function fmtTime(ts: number | null): string {
  if (!ts) return '尚未同步'
  const min = Math.max(0, Math.floor((Date.now() - ts) / 60000))
  if (min < 1) return '刚刚同步'
  if (min < 60) return min + ' 分钟前'
  const hr = Math.floor(min / 60)
  return hr < 24 ? hr + ' 小时前' : Math.floor(hr / 24) + ' 天前'
}

const columns = computed<DataTableColumns<MailAccount>>(() => [
  {
    title: '账户',
    key: 'alias',
    render: (row) => h('div', { class: 'set-cell' }, [
      h('strong', row.alias || row.email),
      h('small', row.email + ' · ' + String(row.protocol || 'imap').toUpperCase())
    ])
  },
  { title: '同步状态', key: 'lastSyncAt', width: 150, render: (row) => h('span', fmtTime(row.lastSyncAt)) },
  {
    title: '启用',
    key: 'enabled',
    width: 70,
    render: (row) => h(NSwitch, {
      size: 'small',
      value: row.enabled,
      'onUpdate:value': (v: boolean) => toggleAccount(row, v)
    })
  },
  {
    title: '操作',
    key: 'actions',
    width: 210,
    render: (row) => h('div', { class: 'set-inline' }, [
      h(NButton, { size: 'tiny', quaternary: true, onClick: () => openEdit(row) }, { default: () => '编辑' }),
      h(NButton, { size: 'tiny', quaternary: true, onClick: () => test(row) }, { default: () => '测试连接' }),
      h(NPopconfirm, { onPositiveClick: () => removeAccount(row) }, {
        trigger: () => h(NButton, { size: 'tiny', quaternary: true, type: 'error' }, { default: () => '删除' }),
        default: () => '删除账户会一并移除本地缓存邮件，确定继续？'
      })
    ])
  }
])

async function load() {
  if (!hasBridge()) { accounts.value = []; return }
  loading.value = true
  try {
    accounts.value = await call(() => bridge().mail.accounts(), [] as MailAccount[])
  } catch (e) {
    log.exception('settings.mailAccounts', e)
    message.error('读取账户失败：' + ((e as Error).message || '未知错误'))
  } finally {
    loading.value = false
  }
}

function openAdd() {
  editingId.value = null
  testText.value = ''
  form.value = { alias: '', email: '', protocol: 'imap', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, username: '', secret: '', syncDays: 30 }
  showForm.value = true
}

function openEdit(row: MailAccount) {
  editingId.value = row.id
  testText.value = ''
  form.value = {
    alias: row.alias || '', email: row.email || '', protocol: row.protocol || 'imap',
    imapHost: row.imapHost || '', imapPort: row.imapPort ?? null,
    smtpHost: row.smtpHost || '', smtpPort: row.smtpPort ?? null,
    username: row.username || '', secret: '', syncDays: row.syncDays || 30
  }
  showForm.value = true
}

async function submit() {
  const f = form.value
  if (!f.email.trim()) { message.warning('请填写邮箱地址'); return }
  if (!f.imapHost.trim() && !f.smtpHost.trim()) { message.warning('请至少填写 IMAP 或 SMTP 服务器'); return }
  try {
    const base = {
      alias: f.alias.trim() || f.email.trim(), email: f.email.trim(), protocol: f.protocol,
      imapHost: f.imapHost.trim() || null, imapPort: f.imapPort, smtpHost: f.smtpHost.trim() || null,
      smtpPort: f.smtpPort, username: f.username.trim() || f.email.trim(), syncDays: f.syncDays
    }
    if (editingId.value) {
      const dto = f.secret.trim() ? { ...base, id: editingId.value, secret: f.secret.trim() } : { ...base, id: editingId.value }
      accounts.value = await call(() => bridge().mail.updateAccount(plain(dto) as Record<string, unknown>), accounts.value)
      message.success('账户已更新')
    } else {
      if (!f.secret.trim()) { message.warning('新增账户必须填写授权码'); return }
      accounts.value = await call(() => bridge().mail.addAccount(plain({ ...base, secret: f.secret.trim() }) as Record<string, unknown>), accounts.value)
      message.success('账户已添加')
    }
    showForm.value = false
  } catch (e) {
    log.exception('settings.mailAccount.save', e)
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function test(row?: MailAccount) {
  testing.value = true
  testText.value = ''
  try {
    const f = form.value
    const dto = row
      ? { id: row.id, email: row.email }
      : { email: f.email, protocol: f.protocol, imapHost: f.imapHost, imapPort: f.imapPort, smtpHost: f.smtpHost, smtpPort: f.smtpPort, username: f.username, secret: f.secret }
    const r = await call(() => bridge().mail.testAccount(plain(dto) as Record<string, unknown>), null as unknown as { ok: boolean; message?: string } | null)
    if (!r) { testText.value = '未在 Electron 中运行，无法测试连接'; return }
    testText.value = (r.ok ? '连接成功：' : '连接失败：') + (r.message || '')
    message[r.ok ? 'success' : 'error'](testText.value)
  } catch (e) {
    log.exception('settings.mailTest', e)
    message.error('测试失败：' + ((e as Error).message || '未知错误'))
  } finally {
    testing.value = false
  }
}

async function toggleAccount(row: MailAccount, enabled: boolean) {
  try {
    accounts.value = await call(() => bridge().mail.updateAccount(plain({ id: row.id, enabled }) as Record<string, unknown>), accounts.value)
  } catch (e) {
    log.exception('settings.mailToggle', e)
    message.error('更新失败：' + ((e as Error).message || '未知错误'))
  }
}

async function removeAccount(row: MailAccount) {
  try {
    accounts.value = await call(() => bridge().mail.removeAccount({ id: row.id }), accounts.value)
    message.success('账户已删除')
  } catch (e) {
    log.exception('settings.mailRemove', e)
    message.error('删除失败：' + ((e as Error).message || '未知错误'))
  }
}

onMounted(load)
</script>

<template>
  <n-card size="small" title="邮箱账户">
    <template #header-extra><n-tag size="small">授权信息本机加密保存</n-tag></template>

    <n-spin :show="loading">
      <n-empty v-if="!accounts.length" size="small" description="还没有配置邮箱账户" />
      <n-data-table
        v-else
        size="small"
        :columns="columns"
        :data="accounts"
        :bordered="false"
        :single-line="false"
        :row-key="(row: MailAccount) => row.id"
      />
    </n-spin>

    <div class="set-actions">
      <n-button size="small" type="primary" @click="openAdd">+ 添加邮箱账户</n-button>
      <n-button size="small" :loading="loading" @click="load">刷新</n-button>
    </div>
    <p class="set-muted">授权信息仅加密保存在本机；应用不提供账户体系，邮件由外部邮件服务收发。</p>

    <n-modal v-model:show="showForm" preset="card" class="set-modal" :title="editingId ? '编辑邮箱账户' : '添加邮箱账户'" :bordered="false">
      <n-form label-placement="left" :label-width="92" size="small">
        <n-form-item label="别名"><n-input v-model:value="form.alias" placeholder="工作邮箱" /></n-form-item>
        <n-form-item label="邮箱地址"><n-input v-model:value="form.email" placeholder="name@example.com" /></n-form-item>
        <n-form-item label="协议">
          <n-select v-model:value="form.protocol" :options="protocolOptions" />
        </n-form-item>
        <n-form-item label="IMAP">
          <div class="set-inline">
            <n-input v-model:value="form.imapHost" placeholder="imap.example.com" />
            <n-input-number v-model:value="form.imapPort" :show-button="false" class="set-port" />
          </div>
        </n-form-item>
        <n-form-item label="SMTP">
          <div class="set-inline">
            <n-input v-model:value="form.smtpHost" placeholder="smtp.example.com" />
            <n-input-number v-model:value="form.smtpPort" :show-button="false" class="set-port" />
          </div>
        </n-form-item>
        <n-form-item label="用户名"><n-input v-model:value="form.username" placeholder="默认与邮箱地址相同" /></n-form-item>
        <n-form-item :label="editingId ? '授权码（可留空）' : '授权码'">
          <n-input v-model:value="form.secret" type="password" show-password-on="click" placeholder="仅加密保存在本机" />
        </n-form-item>
        <n-form-item label="同步范围">
          <n-select v-model:value="form.syncDays" :options="syncOptions" />
        </n-form-item>
      </n-form>
      <n-alert v-if="testText" type="info" :bordered="false">{{ testText }}</n-alert>
      <template #footer>
        <div class="set-inline set-inline-end">
          <n-button size="small" :loading="testing" @click="test()">测试连接</n-button>
          <n-button size="small" @click="showForm = false">取消</n-button>
          <n-button size="small" type="primary" @click="submit">保存</n-button>
        </div>
      </template>
    </n-modal>
  </n-card>
</template>
