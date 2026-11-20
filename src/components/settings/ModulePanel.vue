<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NTag, NDescriptions, NDescriptionsItem, useMessage } from 'naive-ui'
import { useSettings } from '@/composables/useSettings'
import type { ModulesSetting } from '@/types/api'

const props = defineProps<{ moduleKey: string; label: string }>()
const { settings, save } = useSettings()
const message = useMessage()

const HINTS: Record<string, string> = {
  dashboard: '首页卡片网格、今日汇总与快捷入口',
  weather: '逐小时/多日预报、多城市与预警条',
  schedule: '日/周视图、提醒、重复日程与 ICS 导入导出',
  todo: '清单、子任务、截止与专注时长回写',
  pomodoro: '计时、任务绑定、今日番茄与统计',
  feed: 'RSS/Atom 抓取、稍后读与 OPML',
  parcel: '多包裹轨迹、取件码与状态提醒',
  mail: '多邮箱账户、收件箱、规则与本地缓存'
}

const enabled = computed(() => Boolean((settings.value.modules as ModulesSetting)[props.moduleKey as keyof ModulesSetting]))

async function toggle(v: boolean) {
  const next = { ...settings.value.modules, [props.moduleKey]: v } as ModulesSetting
  try {
    await save('modules', next)
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}
</script>

<template>
  <n-card size="small" :title="label">
    <template #header-extra>
      <n-tag size="small" :type="enabled ? 'success' : 'default'">{{ enabled ? '已启用' : '已停用' }}</n-tag>
    </template>

    <div class="set-field">
      <span class="set-field-key">启用该模块</span>
      <n-switch :value="enabled" @update:value="toggle" />
    </div>

    <n-descriptions :column="1" label-placement="left" size="small">
      <n-descriptions-item label="用途">{{ HINTS[moduleKey] || '该模块的设置项统一在此管理' }}</n-descriptions-item>
      <n-descriptions-item label="数据位置">本机 SQLite 数据库，退出应用后仍保留</n-descriptions-item>
      <n-descriptions-item label="联网">仅天气、快递、信息流与邮件需要联网，结果只做本地缓存</n-descriptions-item>
    </n-descriptions>
  </n-card>
</template>
