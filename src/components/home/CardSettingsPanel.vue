<script setup lang="ts">
import { NCard, NSwitch, NTag, NButton, useMessage } from 'naive-ui'
import { CARD_KEYS, CARD_META, useHomeCards } from '@/composables/useHomeCards'
import '@/styles/settings.css'

const { shown, setVisible, hiddenCount } = useHomeCards()
const message = useMessage()

async function toggle(key: (typeof CARD_KEYS)[number], v: boolean) {
  try {
    await setVisible(key, v)
    message.success(v ? '已在首页显示「' + CARD_META[key].label + '」' : '已隐藏「' + CARD_META[key].label + '」')
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function showAll() {
  for (const key of CARD_KEYS) if (!shown(key)) await setVisible(key, true)
  message.success('已恢复显示全部卡片')
}
</script>

<template>
  <n-card size="small" title="首页卡片">
    <template #header-extra>
      <n-tag size="small" :type="hiddenCount ? 'warning' : 'success'">
        {{ hiddenCount ? hiddenCount + ' 张已隐藏' : '全部显示' }}
      </n-tag>
    </template>

    <div class="set-list">
      <div v-for="key in CARD_KEYS" :key="key" class="set-list-row">
        <span class="set-list-main">
          <strong>{{ CARD_META[key].label }}</strong>
          <small>{{ CARD_META[key].hint }}</small>
        </span>
        <n-switch :value="shown(key)" @update:value="(v: boolean) => toggle(key, v)" />
      </div>
    </div>

    <div class="set-actions">
      <n-button size="small" :disabled="!hiddenCount" @click="showAll">全部显示</n-button>
      <span class="set-muted">只影响首页展示，模块页与数据都保留。</span>
    </div>
  </n-card>
</template>
