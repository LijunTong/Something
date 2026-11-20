import type { GlobalThemeOverrides } from 'naive-ui'

/** 原型设计令牌 → Naive UI 全局主题变量。全站唯一的视觉映射出口。 */
export const lightOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#0f766e',
    primaryColorHover: '#14b8a6',
    primaryColorPressed: '#0b5f58',
    primaryColorSuppl: '#14b8a6',
    infoColor: '#0f766e',
    // 组件内文字与浅底色的对比度按 WCAG AA 校准
    successColor: '#146c33',
    warningColor: '#9a3412',
    errorColor: '#b91c1c',
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontFamily: '"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
    fontSize: '13px',
    fontSizeSmall: '12px',
    fontSizeMedium: '13px',
    fontSizeLarge: '14px',
    fontWeightStrong: '600',
    textColorBase: '#1f2937',
    textColor1: '#1f2937',
    textColor2: '#5f6b7a',
    textColor3: '#5f6b7a',
    borderColor: '#e5e7eb',
    dividerColor: '#e5e7eb',
    bodyColor: '#f5f7fa',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    tableHeaderColor: '#f8fafb',
    inputColor: '#ffffff',
    hoverColor: '#f0fdfa',
    boxShadow1: '0 1px 2px rgba(0,0,0,.03)',
    boxShadow2: '0 4px 16px rgba(15,23,42,.08)',
    boxShadow3: '0 24px 64px rgba(15,23,42,.16)'
  },
  Card: { borderRadius: '12px', paddingMedium: '16px', paddingLarge: '18px' },
  Button: { borderRadiusMedium: '8px', borderRadiusSmall: '6px', fontWeight: '500', heightTiny: '24px', heightSmall: '28px' },
  // placeholder 默认 #c2c2c2 不达 AA，改用令牌里的 muted 值
  Input: { borderRadius: '8px', placeholderColor: '#5f6b7a' },
  InternalSelection: { borderRadius: '8px' },
  DataTable: { borderRadius: '10px', thColor: '#f8fafb', tdColor: '#ffffff' },
  Modal: { borderRadius: '12px', padding: '18px' },
  Drawer: { borderRadius: '0' },
  Tag: { borderRadius: '999px' },
  // 订阅源首字头像：默认 #CCC 底 + 白字只有 1.6:1，压到 muted 灰并用小字号塞进 16px 方框
  Avatar: { color: '#5f6b7a', border: 'none', fontSize: '11px' },
  Progress: { fillColor: '#0f766e' },
  Tabs: { tabFontWeightActive: '600' },
  Form: { labelFontSizeTopMedium: '12px' },
  Empty: { iconSize: '36px', textColor: '#5f6b7a' },
  // 日期面板：非当月日期默认 #C2C2C2 不达 AA，这里改用令牌里的 muted 值
  DatePicker: {
    // 面板压到侧栏宽度：缩格子尺寸与内边距，避免第 7 列被裁
    itemSize: '28px',
    calendarTitleFontSize: '13px',
    calendarTitlePadding: '0 2px',
    calendarDaysHeight: '22px',
    panelHeaderPadding: '12px 2px 6px',
    calendarLeftPaddingDate: '4px',
    calendarRightPaddingDate: '4px',
    itemColorActive: '#0f766e',
    itemTextColorActive: '#ffffff',
    itemTextColorCurrent: '#0f766e',
    calendarDaysTextColor: '#5f6b7a',
    panelTextColor: '#1f2937',
    calendarTitleTextColor: '#1f2937',
    itemTextColorDisabled: '#5f6b7a'
  },
  // 迷你日历：压缩标题字号与行高，适配 240px 侧栏宽度
  Calendar: {
    fontSize: '13px',
    lineHeight: '22px',
    titleFontSize: '14px',
    titleFontWeight: '600',
    borderRadius: '6px',
    dayTextColor: '#5f6b7a',
    // 选中日期：默认 dateColorCurrent = primaryColor 是整块实心色，
    // 会盖住日期数字。改成浅主色底 + 主色字，保证可读。
    dateColorCurrent: '#e6f4f1',
    dateTextColorCurrent: '#0f766e'
  }
}

/** 深色：保持同一套蓝绿语义，只换画布与文字层。 */
export const darkOverrides: GlobalThemeOverrides = {
  ...lightOverrides,
  common: {
    ...lightOverrides.common,
    textColorBase: '#e2e8f0',
    textColor1: '#e2e8f0',
    textColor2: '#94a3b8',
    textColor3: '#7b8a9a',
    borderColor: '#334155',
    dividerColor: '#334155',
    bodyColor: '#0f172a',
    cardColor: '#1e293b',
    modalColor: '#1e293b',
    popoverColor: '#1e293b',
    tableColor: '#1e293b',
    tableHeaderColor: '#243447',
    inputColor: '#1e293b',
    hoverColor: '#243447',
    boxShadow1: '0 1px 2px rgba(0,0,0,.3)',
    boxShadow2: '0 4px 16px rgba(0,0,0,.35)',
    boxShadow3: '0 24px 64px rgba(0,0,0,.5)'
  },
  DataTable: { ...lightOverrides.DataTable, thColor: '#243447', tdColor: '#1e293b' },
  Avatar: { ...lightOverrides.Avatar, color: '#526375' },
  Calendar: {
    ...lightOverrides.Calendar,
    dateColorCurrent: '#134e4a',
    dateTextColorCurrent: '#5eead4',
    dayTextColor: '#94a3b8'
  }
}

/** 字号三档：由设置页驱动，改 common.fontSize 即全站生效。 */
export const fontSizes = { 小: '12px', 中: '13px', 大: '14px' } as const
export type FontKey = keyof typeof fontSizes

/* ---------- 强调色：设置页可换，主色派生 hover/pressed 保证深浅一致 ---------- */

function parseHex(hex: string): [number, number, number] {
  const h = String(hex || '').replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full.slice(0, 6) || '0f766e', 16)
  if (Number.isNaN(n)) return [15, 118, 110]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

/** 把颜色朝白（ratio>0）或黑（ratio<0）混合，用于派生 hover/pressed。 */
export function blendColor(hex: string, ratio: number): string {
  const rgb = parseHex(hex)
  const target = ratio >= 0 ? 255 : 0
  const k = Math.abs(ratio)
  return toHex([rgb[0] + (target - rgb[0]) * k, rgb[1] + (target - rgb[1]) * k, rgb[2] + (target - rgb[2]) * k])
}

/** 两个颜色按比例混合：用于在深色画布上生成主色底纹 */
export function mixColor(base: string, overlay: string, ratio: number): string {
  const a = parseHex(base)
  const b = parseHex(overlay)
  return toHex([a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio, a[2] + (b[2] - a[2]) * ratio])
}

export function accentPalette(accent: string) {
  const color = /^#[0-9a-fA-F]{6}$/.test(accent || '') ? accent : '#0f766e'
  return {
    primaryColor: color,
    primaryColorHover: blendColor(color, 0.18),
    primaryColorPressed: blendColor(color, -0.2),
    primaryColorSuppl: blendColor(color, 0.12),
    infoColor: color
  }
}

export function buildOverrides(theme: '浅色' | '深色' | '跟随系统', font: FontKey, dark: boolean, accent = '#0f766e'): GlobalThemeOverrides {
  const base = dark || theme === '深色' ? darkOverrides : lightOverrides
  // 深色下把强调色提亮，否则深底上的主色文字/描边对比度不足
  const tunedAccent = dark ? blendColor(accent, 0.42) : accent
  return {
    ...base,
    common: { ...base.common, fontSize: fontSizes[font] ?? '13px', ...accentPalette(tunedAccent) }
  }
}

/** 统一层级：弹层与抽屉的 z-index 契约，避免 Naive UI 与自有浮层打架。 */
export const Z = { drawer: 1000, modal: 1100, popover: 1200, message: 3000 } as const