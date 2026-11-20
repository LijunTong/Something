<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NCard, NButton, NTag, NInput, useMessage } from 'naive-ui'
import { useSettings } from '@/composables/useSettings'
import type { ShortcutSetting } from '@/types/api'

const { settings, save } = useSettings()
const message = useMessage()

const ROWS: Array<{ key: keyof ShortcutSetting; label: string; hint: string }> = [
  { key: 'search', label: '全局搜索', hint: '聚焦顶栏搜索框' },
  { key: 'newTodo', label: '新建任务', hint: '在待办页快速新增' },
  { key: 'focus', label: '开始专注', hint: '从当前任务进入番茄钟' },
  { key: 'quickAdd', label: '快捷添加', hint: '打开快捷添加面板' },
  { key: 'viewSwitch', label: '切换视图', hint: '列表 / 看板 / 日历' }
]

const recording = ref<keyof ShortcutSetting | null>(null)

const items = computed(() => ROWS.map((r) => ({ ...r, value: settings.value.shortcuts[r.key] })))

function startRecord(key: keyof ShortcutSetting) {
  recording.value = key
  window.addEventListener('keydown', onKey, true)
}

function stopRecord() {
  recording.value = null
  window.removeEventListener('keydown', onKey, true)
}

function combo(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  const code = e.code || ''
  let key = e.key
  if (code.startsWith('Key')) key = code.slice(3)
  else if (code.startsWith('Digit')) key = code.slice(5)
  else if (code === 'Space') key = 'Space'
  else if (code.startsWith('F') && code.length <= 3) key = code
  else if (key === ' ') key = 'Space'
  if (key && ['Control', 'Alt', 'Shift', 'Meta'].indexOf(key) < 0) parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}

async function onKey(e: KeyboardEvent) {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') { stopRecord(); return }
  const key = combo(e)
  if (!recording.value || !key) return
  const target = recording.value
  const next = { ...settings.value.shortcuts, [target]: key } as ShortcutSetting
  stopRecord()
  try {
    await save('shortcuts', next)
    message.success('快捷键已更新为 ' + key)
  } catch (err) {
    message.error('保存失败：' + ((err as Error).message || '未知错误'))
  }
}

async function resetDefault() {
  const def: ShortcutSetting = { search: 'Ctrl+K', newTodo: 'N', focus: 'F', quickAdd: 'Space', viewSwitch: 'Ctrl+1-3' }
  try {
    await save('shortcuts', def)
    message.success('已恢复默认快捷键')
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

onBeforeUnmount(stopRecord)
</script>

<template>
  <n-card size="small" title="快捷键">
    <template #header-extra><n-tag size="small">点击按键组合可重新录制</n-tag></template>

    <div class="set-list">
      <div v-for="row in items" :key="row.key" class="set-list-row">
        <span class="set-list-main">
          <strong>{{ row.label }}</strong>
          <small>{{ row.hint }}</small>
        </span>
        <div class="set-inline set-inline-end">
          <n-input
            class="set-key-input"
            size="small"
            readonly
            :value="recording === row.key ? '请按下组合键…' : row.value"
            @click="startRecord(row.key)"
          />
          <n-tag v-if="recording === row.key" size="tiny" type="warning">录制中 · Esc 取消</n-tag>
        </div>
      </div>
    </div>

    <div class="set-actions">
      <n-button size="small" @click="resetDefault">恢复默认</n-button>
      <span class="set-muted">快捷键保存在本机，跟随外观设置一起导出。</span>
    </div>
  </n-card>
</template>
