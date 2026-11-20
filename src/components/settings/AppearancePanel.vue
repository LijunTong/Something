<script setup lang="ts">
import { NCard, NRadioGroup, NRadioButton, NSwitch, NButton, NTooltip, NTag, useMessage } from 'naive-ui'
import { useSettings } from '@/composables/useSettings'
import type { AppearanceSetting } from '@/types/api'

const { settings, save } = useSettings()
const message = useMessage()

const ACCENTS = ['#0f766e', '#2563eb', '#7c3aed', '#c2410c', '#db2777', '#0ea5e9']
const THEMES: Array<AppearanceSetting['theme']> = ['浅色', '深色', '跟随系统']
const FONTS: Array<AppearanceSetting['font']> = ['小', '中', '大']

async function patch(p: Partial<AppearanceSetting>) {
  try {
    await save('appearance', { ...settings.value.appearance, ...p })
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}
</script>

<template>
  <n-card size="small" title="外观">
    <template #header-extra><n-tag size="small">即时生效</n-tag></template>

    <div class="set-sub">主题</div>
    <n-radio-group
      :value="settings.appearance.theme"
      @update:value="(v: AppearanceSetting['theme']) => patch({ theme: v })"
    >
      <n-radio-button v-for="t in THEMES" :key="t" :value="t" :label="t" />
    </n-radio-group>

    <div class="set-sub">强调色</div>
    <div class="set-colors">
      <n-tooltip v-for="c in ACCENTS" :key="c" trigger="hover">
        <template #trigger>
          <n-button
            circle
            size="small"
            :style="{ background: c, borderColor: c }"
            :aria-label="'强调色 ' + c"
            @click="patch({ accent: c })"
          >
            <!-- 勾选态用白色：色块本身是用户选定的强调色，只有白线在 6 个候选色上都满足对比度 -->
            <svg
              v-if="settings.appearance.accent === c"
              class="set-swatch-check"
              viewBox="0 0 24 24"
              style="color: #fff"
            >
              <use href="#i-check" />
            </svg>
          </n-button>
        </template>
        {{ c }}{{ settings.appearance.accent === c ? '（当前）' : '' }}
      </n-tooltip>
    </div>
    <p class="set-muted">强调色会替换全站主色（按钮、开关、选中态），深浅色主题共用同一套色阶。</p>

    <div class="set-sub">字号</div>
    <n-radio-group
      :value="settings.appearance.font"
      @update:value="(v: AppearanceSetting['font']) => patch({ font: v })"
    >
      <n-radio-button v-for="f in FONTS" :key="f" :value="f" :label="f" />
    </n-radio-group>

    <div class="set-sub">侧边栏</div>
    <div class="set-field">
      <span class="set-field-key">始终展开 / 可折叠</span>
      <n-switch
        :value="settings.appearance.sidebarExpand"
        @update:value="(v: boolean) => patch({ sidebarExpand: v })"
      />
    </div>
    <p class="set-muted">关闭后侧边栏收为图标条，只保留模块图标与本地状态点。</p>
  </n-card>
</template>
