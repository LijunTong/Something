<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NCard, NButton, NSwitch, NSelect, NInput, NInputNumber, NTag, NAlert, NPopconfirm,
  NUpload, NModal, NEmpty, NSpin, NDescriptions, NDescriptionsItem, useMessage, useDialog
} from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { PARCEL_ENABLED } from '@/lib/features'
import { useAppStore } from '@/stores/app'
import { useSettings } from '@/composables/useSettings'
import SectionTitle from '@/components/settings/SectionTitle.vue'
import type { BackupFile, BackupSetting, ExportResult, RestoreResult, StorageUsage } from '@/types/api'

const { settings, save, load } = useSettings()
const store = useAppStore()
const message = useMessage()
const dialog = useDialog()

const storage = ref<StorageUsage | null>(null)
const backupFiles = ref<BackupFile[]>([])
const loading = ref(false)
const busy = ref('')
const backupPassword = ref('')
const showRestore = ref(false)
const restorePassword = ref('')
const pendingRestore = ref<{ text: string; encrypted: boolean; at: number | null; counts: Record<string, number> } | null>(null)

const freqOptions = [
  { label: '每天', value: '每天' },
  { label: '每周', value: '每周' },
  { label: '每次退出', value: '每次退出' }
]

const EXPORTS: Array<{ kind: 'json' | 'ics' | 'opml' | 'eml'; label: string }> = [
  { kind: 'json', label: '导出全部数据（JSON）' },
  { kind: 'ics', label: '导出日程（ICS）' },
  { kind: 'opml', label: '导出订阅源（OPML）' },
  { kind: 'eml', label: '导出邮件（EML/MBOX）' }
]

function fmtBytes(n: number): string {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

const segments = computed(() => {
  const list = storage.value?.segments ?? []
  const sum = list.reduce((s, x) => s + x.bytes, 0) || 1
  return list.map((s) => ({ ...s, pct: (s.bytes / sum) * 100, size: fmtBytes(s.bytes) }))
})
const totalText = computed(() => fmtBytes(storage.value?.totalBytes ?? 0))
const dbText = computed(() => fmtBytes(storage.value?.dbBytes ?? 0))

async function loadStorage() {
  if (!hasBridge()) return
  loading.value = true
  try {
    const [s, b] = await Promise.all([
      call(() => bridge().settings.storage(), null as unknown as StorageUsage),
      call(() => bridge().settings.backups(), { dir: '', files: [] as BackupFile[] })
    ])
    if (s) storage.value = s
    backupFiles.value = b?.files ?? []
  } catch (e) {
    log.exception('settings.storage', e)
  } finally {
    loading.value = false
  }
}

async function saveBackup(patch: Partial<BackupSetting>) {
  try {
    await save('backup', { ...settings.value.backup, ...patch })
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function choosePath() {
  try {
    const r = await call(() => bridge().system.chooseDir({ title: '选择备份目录', defaultPath: settings.value.backup.path || '' }), { path: null } as { path: string | null })
    if (!r?.path) return
    await saveBackup({ path: r.path })
    message.success('备份目录已更新')
    await loadStorage()
  } catch (e) {
    log.exception('settings.chooseDir', e)
    message.error('选择目录失败：' + ((e as Error).message || '未知错误'))
  }
}

async function openPath(p: string | null | undefined) {
  if (!p) return
  try {
    await call(() => bridge().system.openPath(p), false)
  } catch (e) {
    log.exception('settings.openPath', e)
    message.error('打开失败：' + ((e as Error).message || '未知错误'))
  }
}

async function doBackup() {
  busy.value = 'backup'
  try {
    const r = await call(() => bridge().settings.backup({ password: backupPassword.value || undefined }), null as unknown as { path: string; bytes: number; encrypted: boolean })
    message.success('备份已完成：' + (r?.path || ''))
    // 备份会把 lastAt/lastFile 写回设置，重新拉一次让「上次备份」立即更新
    await Promise.all([loadStorage(), load(true)])
  } catch (e) {
    log.exception('settings.backup', e)
    message.error('备份失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = ''
  }
}

async function exportAs(kind: 'json' | 'ics' | 'opml' | 'eml') {
  busy.value = 'export'
  try {
    const r = await call(() => bridge().settings.exportData({ kind }), null as unknown as ExportResult)
    message.success('已导出：' + (r?.name || kind))
    if (r?.path) await openPath(r.path)
  } catch (e) {
    log.exception('settings.export', e)
    message.error('导出失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = ''
  }
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('FILE_READ_FAILED'))
    reader.readAsText(file, 'utf-8')
  })
}

async function onPick(payload: { file: { file: File | null } }) {
  const raw = payload?.file?.file
  if (!raw) return
  try {
    const text = await readFileText(raw)
    let data: { magic?: string; at?: number; counts?: Record<string, number> } = {}
    try { data = JSON.parse(text) } catch (e) { throw new Error('备份文件不是合法 JSON') }
    const encrypted = data?.magic === 'EFFICIENCY-BACKUP-ENC-1'
    if (data?.magic !== 'EFFICIENCY-BACKUP-1' && !encrypted) throw new Error('备份文件格式不匹配')
    pendingRestore.value = { text, encrypted, at: data?.at ?? null, counts: data?.counts ?? {} }
    restorePassword.value = ''
    showRestore.value = true
  } catch (e) {
    log.exception('settings.restore.pick', e)
    message.error('无法读取备份：' + ((e as Error).message || '未知错误'))
  }
}

async function confirmRestore() {
  const p = pendingRestore.value
  if (!p) return
  busy.value = 'restore'
  try {
    const r = await call(() => bridge().settings.restore({ text: p.text, password: restorePassword.value || undefined }), null as unknown as RestoreResult)
    const total = Object.values(r?.restored ?? {}).reduce((s, n) => s + Number(n || 0), 0)
    message.success('已恢复 ' + total + ' 条记录，恢复前快照：' + (r?.snapshot || '—'))
    showRestore.value = false
    pendingRestore.value = null
    await store.init()
    await Promise.all([loadStorage(), load(true)])
  } catch (e) {
    log.exception('settings.restore', e)
    message.error('恢复失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = ''
  }
}

function askReset() {
  dialog.error({
    title: '重置全部数据',
    content: '这会清空本机保存的全部日程、待办、邮件缓存、订阅文章' + (PARCEL_ENABLED ? '与包裹记录' : '') + '，且不可恢复。建议先执行一次备份。',
    positiveText: '确认重置',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await call(() => bridge().settings.resetAll(), false)
        message.success('已重置本机数据')
        await store.init()
        await loadStorage()
      } catch (e) {
        log.exception('settings.resetAll', e)
        message.error('重置失败：' + ((e as Error).message || '未知错误'))
      }
    }
  })
}

async function clearCache() {
  try {
    const r = await call(() => bridge().settings.clearCache(), { weather: 0, feed: 0, mail: 0 })
    message.success('已清空缓存：天气 ' + r.weather + ' 项 · 文章正文 ' + r.feed + ' 条 · 邮件正文 ' + r.mail + ' 条')
    await loadStorage()
  } catch (e) {
    log.exception('settings.clearCache', e)
    message.error('清空缓存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function clearTrash() {
  try {
    const r = await call(() => bridge().settings.clearTrash(), { todos: 0, parcels: 0 })
    message.success('回收站已清空：待办 ' + r.todos + ' 项' + (PARCEL_ENABLED ? ' · 归档包裹 ' + r.parcels + ' 个' : ''))
    await loadStorage()
  } catch (e) {
    log.exception('settings.clearTrash', e)
    message.error('清空回收站失败：' + ((e as Error).message || '未知错误'))
  }
}

onMounted(loadStorage)
</script>

<template>
  <n-spin :show="loading">
    <div class="set-sections">
      <n-card size="small" title="本地存储">
        <div class="set-usage">
          <div class="set-bar" role="img" aria-label="本地存储占用分布">
            <i
              v-for="s in segments"
              :key="s.key"
              :style="{ width: s.pct + '%', background: s.color }"
              :title="s.label + ' ' + s.size"
            ></i>
          </div>
          <span class="set-usage-total">共 {{ totalText }}</span>
        </div>
        <div class="set-legend">
          <span v-for="s in segments" :key="s.key">
            <i :style="{ background: s.color }"></i>{{ s.label }} {{ s.size }}
          </span>
        </div>
        <p class="set-note">
          数据库文件 {{ dbText }} · 待办 {{ storage?.counts.todo ?? 0 }} · 日程 {{ storage?.counts.schedule ?? 0 }} · 邮件 {{ storage?.counts.mail ?? 0 }} · 文章 {{ storage?.counts.feed ?? 0 }}
        </p>
      </n-card>

      <n-card size="small" title="自动备份">
        <div class="set-field">
          <span class="set-field-key">自动备份到本地目录</span>
          <n-switch :value="settings.backup.auto" @update:value="(v: boolean) => saveBackup({ auto: v })" />
        </div>
        <div class="set-field">
          <span class="set-field-key">备份路径</span>
          <div class="set-inline">
            <span class="set-field-value">{{ settings.backup.path || storage?.backupDir || '数据库同级 backups 目录' }}</span>
            <n-button size="tiny" @click="choosePath">更改</n-button>
            <n-button size="tiny" quaternary @click="openPath(settings.backup.path || storage?.backupDir)">打开</n-button>
          </div>
        </div>
        <div class="set-field">
          <span class="set-field-key">备份频率</span>
          <n-select
            class="set-select"
            size="small"
            :value="settings.backup.freq"
            :options="freqOptions"
            @update:value="(v: string) => saveBackup({ freq: v as BackupSetting['freq'] })"
          />
        </div>
        <div class="set-field">
          <span class="set-field-key">保留份数</span>
          <n-input-number
            class="set-input"
            size="small"
            :value="settings.backup.keep"
            :min="1"
            :max="100"
            :step="1"
            @update:value="(v: number | null) => saveBackup({ keep: v ?? 10 })"
          />
        </div>
        <div class="set-actions">
          <n-button size="small" type="primary" :loading="busy === 'backup'" @click="doBackup">立即备份</n-button>
          <span class="set-muted" v-if="settings.backup.lastAt">上次备份 {{ new Date(settings.backup.lastAt).toLocaleString('zh-CN') }}</span>
          <span class="set-muted" v-else>尚未执行过备份</span>
        </div>

        <p class="set-note">自动备份在启动、运行中每 30 分钟检查与退出时触发；「每天/每周」按上次备份时间判断是否到期。只保留最近「保留份数」份，超出的旧文件会自动删除。开启加密后后台无法输入密码，自动备份会跳过，仅手动备份生效。</p>

        <SectionTitle title="加密" />
        <div class="set-field">
          <span class="set-field-key">为备份文件设置密码</span>
          <n-switch :value="settings.backup.encrypted" @update:value="(v: boolean) => saveBackup({ encrypted: v })" />
        </div>
        <div class="set-field">
          <span class="set-field-key">密码</span>
          <n-input
            class="set-input"
            size="small"
            type="password"
            show-password-on="click"
            :disabled="!settings.backup.encrypted"
            placeholder="仅在本次备份时使用"
            :value="backupPassword"
            @update:value="(v: string) => (backupPassword = v)"
          />
        </div>
        <p class="set-note">密码只在本次备份的内存中使用，不写入数据库；忘记密码将无法恢复对应备份文件。</p>
      </n-card>

      <n-card size="small" title="导出与导入">
        <SectionTitle title="导出" />
        <div class="set-export-grid">
          <n-button
            v-for="x in EXPORTS"
            :key="x.kind"
            size="small"
            block
            :disabled="busy === 'export'"
            @click="exportAs(x.kind)"
          >{{ x.label }}</n-button>
        </div>
        <p class="set-note">导出文件写入本机 exports 目录，完成后会自动打开所在位置。</p>

        <SectionTitle title="从备份恢复" />
        <div class="set-actions">
          <n-upload :show-file-list="false" :default-upload="false" accept=".json" :disabled="busy === 'restore'" @change="onPick">
            <n-button size="small">选择备份文件</n-button>
          </n-upload>
          <span class="set-muted">恢复会覆盖当前数据，请先备份</span>
        </div>
      </n-card>

      <n-card size="small" title="备份记录">
        <template #header-extra>
          <n-tag size="small">{{ backupFiles.length }} 个文件</n-tag>
        </template>
        <n-empty v-if="!backupFiles.length" size="small" description="还没有备份文件" />
        <div v-else class="set-list">
          <div v-for="f in backupFiles" :key="f.path" class="set-list-row">
            <span class="set-list-main">
              <strong>{{ f.name }}</strong>
              <small>{{ fmtBytes(f.bytes) }} · {{ new Date(f.at).toLocaleString('zh-CN') }}{{ f.encrypted ? ' · 已加密' : '' }}</small>
            </span>
            <n-button size="tiny" quaternary @click="openPath(f.path)">查看</n-button>
          </div>
        </div>
      </n-card>

      <n-card size="small" title="危险操作">
        <template #header-extra>
          <n-tag size="small" type="error">不可撤销</n-tag>
        </template>
        <div class="set-actions">
          <n-popconfirm @positive-click="clearCache">
            <template #trigger><n-button size="small">清空缓存</n-button></template>
            清空天气缓存与已读正文缓存？记录本身会保留。
          </n-popconfirm>
          <n-popconfirm @positive-click="clearTrash">
            <template #trigger><n-button size="small">清空回收站</n-button></template>
            永久删除已删除待办{{ PARCEL_ENABLED ? '与已归档包裹' : '' }}？
          </n-popconfirm>
          <n-button size="small" type="error" @click="askReset">重置全部数据</n-button>
        </div>
      </n-card>
    </div>
  </n-spin>

  <n-modal
    v-model:show="showRestore"
    preset="card"
    title="从备份恢复"
    class="set-modal"
    :bordered="false"
  >
    <n-alert v-if="!pendingRestore" type="warning" :bordered="false">没有待恢复的备份内容。</n-alert>
    <template v-else>
      <n-descriptions :column="1" label-placement="left" size="small">
        <n-descriptions-item label="格式">{{ pendingRestore.encrypted ? '加密备份' : '明文备份' }}</n-descriptions-item>
        <n-descriptions-item label="备份时间">
          {{ pendingRestore.at ? new Date(pendingRestore.at).toLocaleString('zh-CN') : '未记录' }}
        </n-descriptions-item>
        <n-descriptions-item label="包含表">{{ Object.keys(pendingRestore.counts || {}).length }} 张</n-descriptions-item>
      </n-descriptions>
      <n-alert type="warning" :bordered="false" class="set-result">
        恢复会覆盖当前全部数据。系统会先自动拍一份当前数据快照，恢复异常时可用于回退。
      </n-alert>
      <div v-if="pendingRestore.encrypted" class="set-field">
        <span class="set-field-key">备份密码</span>
        <n-input
          class="set-input"
          size="small"
          type="password"
          show-password-on="click"
          :value="restorePassword"
          @update:value="(v: string) => (restorePassword = v)"
        />
      </div>
    </template>
    <template #footer>
      <div class="set-inline set-inline-end">
        <n-button size="small" @click="showRestore = false">取消</n-button>
        <n-button size="small" type="primary" :loading="busy === 'restore'" @click="confirmRestore">开始恢复</n-button>
      </div>
    </template>
  </n-modal>
</template>