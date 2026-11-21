<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NSwitch, NTag, NButton, useMessage, useDialog } from 'naive-ui'
import { CARD_KEYS, CARD_META, useHomeCards } from '@/composables/useHomeCards'
import { defaultLayout, normalizeLayout } from '@/composables/useHomeLayout'
import { useSettings } from '@/composables/useSettings'
import '@/styles/settings.css'

const { shown, setVisible, hiddenCount } = useHomeCards()
const { settings, save } = useSettings()
const message = useMessage()
const dialog = useDialog()

const layout = computed(() => normalizeLayout(settings.value.home && settings.value.home.layout))
const locked = computed(() => settings.value.home && settings.value.home.locked === true)
const isDefault = computed(() => JSON.stringify(layout.value) === JSON.stringify(defaultLayout()))

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

/** 锁定只关掉首页的拖动与缩放手柄，不改动布局本身 */
async function setLocked(v: boolean) {
  try {
    await save('home', { layout: layout.value, locked: v })
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

function resetLayout() {
  dialog.warning({
    title: '恢复默认布局',
    content: '把首页卡片的位置与大小恢复成默认？卡片显隐设置不受影响。',
    positiveText: '恢复',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await save('home', { layout: defaultLayout(), locked: false })
        message.success('已恢复默认布局')
      } catch (e) {
        message.error('保存失败：' + ((e as Error).message || '未知错误'))
      }
    }
  })
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
      <div class="set-list-row">
        <span class="set-list-main">
          <strong>锁定布局</strong>
          <small>锁定时首页卡片不能拖动排序，也不能调整大小</small>
        </span>
        <n-switch :value="locked" @update:value="setLocked" />
      </div>
    </div>

    <div class="set-section">卡片显示</div>
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
      <n-button size="small" :disabled="isDefault && !locked" @click="resetLayout">恢复默认布局</n-button>
      <span class="set-muted">只影响首页展示，模块页与数据都保留。</span>
    </div>

    <p class="set-note">首页按住卡片标题拖动到别的位置，拖动卡片右下角调整大小；卡片获得焦点后也能用方向键移动、Shift 加方向键调整大小。</p>
  </n-card>
</template>
