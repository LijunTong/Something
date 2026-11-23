<script setup lang="ts">
// 通知：系统通知（通知中心 toast）与应用内通知（应用内浮层 + 今日通知）两条通道，
// 分模块开关对两条通道同时生效；免打扰只压系统通知，隐私摘要只改系统通知文案。
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { computed } from 'vue'
import { NButton, NCard, NSelect, NSwitch, NTag, useMessage } from 'naive-ui'
import { useSettings } from '@/composables/useSettings'
import { DEFAULT_SOUND, SOUND_OPTIONS, playNotifySound } from '@/composables/useNotifySound'
import type { NotifySetting, NotifySoundModule } from '@/types/api'

const { settings, save } = useSettings()
const message = useMessage()

const MODULES: Array<{ key: NotifySoundModule; label: string; hint: string }> = [
  { key: 'weather', label: '天气', hint: '预警推送，以及每天 9 / 12 / 17 / 20 点的天气播报' },
  { key: 'schedule', label: '日程提醒', hint: '按每条日程的提前分钟数提醒' },
  { key: 'todo', label: '待办到期', hint: '提醒时间到点、到期与逾期' },
  { key: 'pomodoro', label: '番茄结束', hint: '专注结束与休息结束' },
  { key: 'parcel', label: '快递状态', hint: '派送中、待取件、已签收' },
  { key: 'mail', label: '新邮件', hint: '重要未读邮件汇总' }
]

/** 两条通道都关掉时，分模块开关没有意义 */
const anyChannel = computed(() => Boolean(settings.value.notify.desktop || settings.value.notify.inApp))

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

/** 当前模块的提示音；旧配置没有 sounds 字段时回退默认蜂鸣 */
function soundOf(key: NotifySoundModule): string {
  const map = settings.value.notify.sounds
  return (map && map[key]) || DEFAULT_SOUND
}

function patchSound(key: NotifySoundModule, value: string) {
  const next = Object.assign({}, settings.value.notify.sounds) as Record<string, string>
  next[key] = value
  void patch({ sounds: next as NotifySetting['sounds'] })
}

</script>

<template>
  <n-card size="small" title="通知">
    <template #header-extra><n-tag size="small" type="success">系统通知 + 应用内通知</n-tag></template>

    <div class="set-field">
      <span class="set-field-key">
        系统通知
        <small class="set-hint">通知中心弹窗，点击直达对应模块</small>
      </span>
      <n-switch :value="settings.notify.desktop" @update:value="(v: boolean) => patch({ desktop: v })" />
    </div>
    <div class="set-field">
      <span class="set-field-key">
        应用内通知
        <small class="set-hint">应用内浮层 + 首页「今日通知」</small>
      </span>
      <n-switch :value="settings.notify.inApp" @update:value="(v: boolean) => patch({ inApp: v })" />
    </div>
    <div class="set-field">
      <span class="set-field-key">系统通知仅在窗口不在前台时弹出</span>
      <n-switch
        :value="settings.notify.systemOnlyAway"
        :disabled="!settings.notify.desktop"
        @update:value="(v: boolean) => patch({ systemOnlyAway: v })"
      />
    </div>
    <SectionTitle title="分模块通知" />
    <div>
      <div v-for="m in MODULES" :key="m.key" class="set-field">
        <span class="set-field-key">{{ m.label }}</span>
        <div class="set-inline">
          <n-select
            class="set-sound"
            size="small"
            :value="soundOf(m.key)"
            :options="SOUND_OPTIONS"
            :disabled="!anyChannel || settings.notify[m.key] === false"
            @update:value="(v: string) => patchSound(m.key, v)"
          />
          <n-button
            size="small"
            quaternary
            :disabled="!anyChannel"
            title="试听"
            aria-label="试听"
            @click="playNotifySound(soundOf(m.key))"
          >
            <template #icon><svg viewBox="0 0 24 24"><use href="#i-play" /></svg></template>
          </n-button>
          <n-switch
            :value="Boolean(settings.notify[m.key])"
            :disabled="!anyChannel"
            @update:value="(v: boolean) => patch({ [m.key]: v } as Partial<NotifySetting>)"
          />
        </div>
      </div>
    </div>
    <p class="set-note">日程按每条记录的提前量提醒；待办在提醒时间与到期时各提醒一次；天气播报每天 9 / 12 / 17 / 20 点各一次，与快递一样取自最近一次本地缓存，不额外联网。</p>

    <SectionTitle title="免打扰时段" />
    <div class="set-field">
      <span class="set-field-key">
        启用免打扰
        <small class="set-hint">打开后才能设置区间，关闭时区间只作记忆值</small>
      </span>
      <n-switch
        :value="settings.notify.dndOn"
        @update:value="(v: boolean) => patch({ dndOn: v })"
      />
    </div>
    <div class="set-field">
      <span class="set-field-key">开始 - 结束</span>
      <div class="set-inline">
        <n-select
          class="set-time"
          size="small"
          :disabled="!settings.notify.dndOn"
          :value="settings.notify.dndStart"
          :options="timeOptions"
          @update:value="(v: string) => patch({ dndStart: v })"
        />
        <span class="set-muted">至</span>
        <n-select
          class="set-time"
          size="small"
          :disabled="!settings.notify.dndOn"
          :value="settings.notify.dndEnd"
          :options="timeOptions"
          @update:value="(v: string) => patch({ dndEnd: v })"
        />
      </div>
    </div>
    <p class="set-note">免打扰只压系统通知，应用内照常保留，不会漏事；跨零点（如 22:00 - 08:00）同样生效。</p>

    <SectionTitle title="通知隐私" />
    <div class="set-field">
      <span class="set-field-key">
        系统通知显示内容
        <small class="set-hint">仅影响系统通知，应用内始终显示完整标题</small>
      </span>
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
