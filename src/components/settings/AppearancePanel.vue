<script setup lang="ts">
import { computed } from 'vue'
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { NCard, NColorPicker, NRadioGroup, NRadioButton, NSwitch, NButton, NTooltip, NTag, useMessage } from 'naive-ui'
import { useSettings } from '@/composables/useSettings'
import type { AppearanceSetting } from '@/types/api'

const { settings, save } = useSettings()
const message = useMessage()

// 当前强调色不在 6 个预置色里 → 末位取色按钮以该色填充，反显用户自选的色值
const isCustomAccent = computed(() => !ACCENTS.includes(settings.value.appearance.accent))

// 自定义色可能是任意亮度，勾选色按亮度取深/浅，避免浅色底上白勾看不见
const customInk = computed(() => {
  const hex = (settings.value.appearance.accent || '').replace('#', '')
  if (hex.length !== 6) return '#fff'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111827' : '#fff'
})

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

    <SectionTitle title="主题" />
    <n-radio-group
      :value="settings.appearance.theme"
      @update:value="(v: AppearanceSetting['theme']) => patch({ theme: v })"
    >
      <n-radio-button v-for="t in THEMES" :key="t" :value="t" :label="t" />
    </n-radio-group>

    <SectionTitle title="强调色" />
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
      <!-- 自定义取色入口：作为色板末位的一颗圆点。用 n-color-picker 的 trigger 插槽换按钮，
           面板位置与外点关闭都归组件管（外面再套 n-popover 会让面板宽度塌成 2px）。
           选中的颜色不在预置色里时，这颗圆点直接用该色填充，形成回显 -->
      <n-color-picker
        :value="settings.appearance.accent"
        :modes="['hex']"
        :show-alpha="false"
        :swatches="ACCENTS"
        :actions="['confirm']"
        placement="bottom-end"
        @update:value="(v: string) => patch({ accent: v })"
      >
        <template #trigger="scope">
          <n-button
            :ref="scope.ref"
            circle
            size="small"
            :tertiary="!isCustomAccent"
            :style="isCustomAccent ? { background: settings.appearance.accent, borderColor: settings.appearance.accent } : undefined"
            :title="'自定义强调色（当前 ' + settings.appearance.accent + '）'"
            aria-label="自定义强调色"
            @click="scope.onClick"
          >
            <svg
              v-if="isCustomAccent"
              class="set-swatch-check"
              viewBox="0 0 24 24"
              :style="{ color: customInk }"
            >
              <use href="#i-check" />
            </svg>
            <svg v-else class="set-swatch-check" viewBox="0 0 24 24"><use href="#i-palette" /></svg>
          </n-button>
        </template>
      </n-color-picker>
    </div>
    <p class="set-muted">强调色会替换全站主色（按钮、开关、选中态），深浅色主题共用同一套色阶。</p>

    <SectionTitle title="字号" />
    <n-radio-group
      :value="settings.appearance.font"
      @update:value="(v: AppearanceSetting['font']) => patch({ font: v })"
    >
      <n-radio-button v-for="f in FONTS" :key="f" :value="f" :label="f" />
    </n-radio-group>

    <SectionTitle title="侧边栏" />
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