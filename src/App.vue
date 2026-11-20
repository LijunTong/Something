<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { NConfigProvider, NLoadingBarProvider, NDialogProvider, NNotificationProvider, NMessageProvider, darkTheme, zhCN, dateZhCN, NAlert } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { blendColor, buildOverrides, mixColor } from '@/theme/naive'

const store = useAppStore()

// 调试用：把最近一次运行时错误的完整信息显示在页面顶部。
// 定位完可删掉这段以及下方 template 里的 <n-alert>。
const lastError = ref<{ message: string; info?: string; stack?: string } | null>(null)
function showError(payload: { message: string; info?: string }) {
  if (lastError.value?.message === payload.message) return
  lastError.value = payload
  setTimeout(() => { lastError.value = null }, 12000)
}
onMounted(() => {
  window.addEventListener('app:error', (e) => showError((e as CustomEvent).detail))
})

// matchMedia 必须在 window 上以方法形式调用，否则 this 丢失会抛 Illegal invocation。
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
const isDark = computed(() => store.themeMode === '深色' || (store.themeMode === '跟随系统' && systemPrefersDark()))
const accent = computed(() => store.settings?.appearance?.accent || '#0f766e')
const overrides = computed(() => buildOverrides(store.themeMode, store.fontMode, isDark.value, accent.value))

// 把主题主色同步到 CSS 变量，供少量自写布局容器使用（AGENTS.md 2.3）
// 字号三档：Naive 组件由 common.fontSize 控制，页面排版用的是 tokens.css 的 --fs-* 令牌，
// 这里把令牌按比例同步缩放，保证「小/中/大」对整页正文同样生效（令牌值仍由主题层给出）。
const FONT_SCALE: Record<'小' | '中' | '大', number> = { 小: 0.92, 中: 1, 大: 1.08 }
const BASE_TOKENS: Record<string, number> = {
  '--fs-11': 11, '--fs-12': 12, '--fs-13': 13, '--fs-14': 14, '--fs-title': 20, '--fs-hero': 44
}

/**
 * 自写样式统一使用的调色板：主题（浅/深）与强调色都在这里映射成 CSS 变量。
 * 组件库外观由 Naive 的 themeOverrides 负责，这两者必须同步，页面才不会「只变一半」。
 */
function palette(dark: boolean, accent: string): Record<string, string> {
  const surface = dark ? '#1e293b' : '#ffffff'
  const canvas = dark ? '#0f172a' : '#f5f7fa'
  // 深色下主色需要「提亮」才能在本体灰蓝底上够对比；提亮后主色底上的文字改用深墨色
  const primary = dark ? blendColor(accent, 0.42) : accent
  return {
    '--bg': canvas,
    '--surface': surface,
    '--surface-2': dark ? '#243447' : '#fbfcfd',
    '--border': dark ? '#334155' : '#e5e7eb',
    '--border-soft': dark ? '#2b3a4e' : '#eef2f5',
    '--border-strong': dark ? '#475569' : '#cbd5e1',
    '--text': dark ? '#e2e8f0' : '#1f2937',
    '--text-2': dark ? '#cbd5e1' : '#3f4b56',
    '--muted': dark ? '#94a3b8' : '#5f6b7a',
    '--muted-2': dark ? '#64748b' : '#94a3b8',
    '--primary': primary,
    '--primary-2': dark ? blendColor(accent, 0.6) : '#14b8a6',
    '--primary-hover': dark ? blendColor(accent, 0.55) : '#0b5f58',
    // 天气 Hero 用独立的深色渐变：深色下保持深底 + 白字，避免提亮主色导致对比度崩掉
    '--hero-from': dark ? mixColor('#0f172a', accent, 0.45) : accent,
    '--hero-to': dark ? mixColor('#0f172a', accent, 0.72) : '#14b8a6',
    '--on-hero': '#ffffff',
    '--primary-soft': mixColor(surface, primary, dark ? 0.34 : 0.2),
    '--primary-softer': mixColor(surface, primary, dark ? 0.16 : 0.08),
    // 深色下主色被提亮，主色底上的文字改用深墨色，保证对比度
    '--on-primary': dark ? '#04211d' : '#ffffff',
    '--switch-knob': '#ffffff',
    '--accent': dark ? '#fb923c' : '#c2410c',
    '--accent-soft': dark ? '#3a2412' : '#fff7ed',
    '--accent-border': dark ? '#7c2d12' : '#fed7aa',
    '--danger': dark ? '#f87171' : '#dc2626',
    '--ok': dark ? '#4ade80' : '#16a34a',
    '--ok-soft': dark ? '#123524' : '#dcfce7',
    '--chip': dark ? '#334155' : '#f1f5f9',
    '--shadow-card': dark ? '0 1px 2px rgba(0,0,0,.4)' : '0 1px 2px rgba(0,0,0,.03)',
    '--shadow-hover': dark ? '0 2px 10px rgba(0,0,0,.45)' : '0 2px 8px rgba(15,118,110,.07)',
    '--overlay': dark ? 'rgba(2,6,23,.6)' : 'rgba(15,23,42,.38)',
    '--toast-bg': dark ? '#0b1220' : '#1f2937',
    '--toast-text': '#ffffff',
    '--focus-bg': '#0b1220'
  }
}

const rootVars = computed(() => {
  const scale = FONT_SCALE[store.fontMode] ?? 1
  const vars: Record<string, string> = {
    ...palette(isDark.value, accent.value),
    '--app-primary': overrides.value.common?.primaryColor || accent.value,
    '--app-primary-soft': overrides.value.common?.primaryColorHover || '#14b8a6'
  }
  for (const key of Object.keys(BASE_TOKENS)) {
    vars[key] = (BASE_TOKENS[key] * scale).toFixed(1).replace(/\.0$/, '') + 'px'
  }
  return vars
})
</script>

<template>
  <div :style="rootVars" style="display:contents">
  <n-config-provider :theme="isDark ? darkTheme : null" :theme-overrides="overrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-loading-bar-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <n-message-provider>
            <div v-if="!store.ready" class="boot-screen">正在加载本地数据…</div>
            <template v-else>
              <n-alert v-if="lastError" type="error" closable style="position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:9999;max-width:720px" @close="lastError = null">
                <div style="font-weight:600">{{ lastError.message }}</div>
                <div v-if="lastError.info" style="font-size:12px;margin-top:4px">{{ lastError.info }}</div>
              </n-alert>
              <div v-if="store.error" class="boot-error">{{ store.error }}</div>
              <router-view />
            </template>
          </n-message-provider>
        </n-notification-provider>
      </n-dialog-provider>
    </n-loading-bar-provider>
  </n-config-provider>
  </div>
</template>

<style>
.boot-screen { display: grid; place-items: center; height: 100vh; color: #64757d; font: 13px system-ui; }
.boot-error { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 9999; padding: 8px 16px; border-radius: 8px; background: #fef2f2; color: #b91c1c; font-size: 12px; }
</style>
