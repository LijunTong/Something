<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NSelect, NTag, useMessage } from 'naive-ui'
import { useSettings } from '@/composables/useSettings'
import type { NotifySetting } from '@/types/api'

const { settings, save } = useSettings()
const message = useMessage()

const MODULES: Array<{ key: keyof NotifySetting; label: string; hint: string }> = [
  { key: 'weather', label: '天气预警', hint: '暴雨、高温、大风等预警进入本地通知流' },
  { key: 'schedule', label: '日程提醒', hint: '按每条日程的提前分钟数提醒' },
  { key: 'todo', label: '待办到期', hint: '到期与逾期任务提醒' },
  { key: 'pomodoro', label: '番茄结束', hint: '专注与休息结束提醒' },
  { key: 'parcel', label: '快递状态', hint: '派送中、待取件、已签收提醒' },
  { key: 'mail', label: '新邮件', hint: '按账户与规则触发，默认只提示有新邮件' }
]

const timeOptions = computed(() => {
  const out: Array<{ label: string; value: string }> = []
  for (let h = 0; h < 24; h++) {
    out.push({ label: String(h).padStart(2, '0') + ':00', value: String(h).padStart(2, '0') + ':00' })
    out.push({ label: String(h).padStart(2, '0') + ':30', value: String(h).padStart(2, '0') + ':30' })
  }
  return out
})

const privacyOptions = [
  { label: '显示完整内容', value: 'full' },
  { label: '仅显示有新消息', value: 'summary' }
]

async function patch(p: Partial<NotifySetting>) {
  try {
    await save('notify', { ...settings.value.notify, ...p })
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}
</script>

<template>
  <n-card size="small" title="通知">
    <template #header-extra><n-tag size="small" type="success">本地系统通知</n-tag></template>

    <div class="set-field">
      <span class="set-field-key">启用桌面通知</span>
      <n-switch :value="settings.notify.desktop" @update:value="(v: boolean) => patch({ desktop: v })" />
    </div>

    <div class="set-sub">分模块通知</div>
    <div v-for="m in MODULES" :key="m.key" class="set-field">
      <span class="set-field-key">
        {{ m.label }}
        <small class="set-hint">{{ m.hint }}</small>
      </span>
      <n-switch
        :value="Boolean(settings.notify[m.key])"
        :disabled="!settings.notify.desktop"
        @update:value="(v: boolean) => patch({ [m.key]: v } as Partial<NotifySetting>)"
      />
    </div>

    <div class="set-sub">免打扰时段</div>
    <div class="set-field">
      <span class="set-field-key">开始 - 结束</span>
      <div class="set-inline">
        <n-select
          class="set-time"
          size="small"
          :value="settings.notify.dndStart"
          :options="timeOptions"
          @update:value="(v: string) => patch({ dndStart: v })"
        />
        <span class="set-muted">至</span>
        <n-select
          class="set-time"
          size="small"
          :value="settings.notify.dndEnd"
          :options="timeOptions"
          @update:value="(v: string) => patch({ dndEnd: v })"
        />
      </div>
    </div>

    <div class="set-sub">通知隐私</div>
    <div class="set-field">
      <span class="set-field-key">显示内容</span>
      <n-select
        class="set-select"
        size="small"
        :value="settings.notify.privacy"
        :options="privacyOptions"
        @update:value="(v: string) => patch({ privacy: v })"
      />
    </div>
  </n-card>
</template>
