/**
 * 天气 Hero 卡配色：按天气现象取「天空色」。
 *
 * 这些颜色不挂在 Naive 组件的皮肤变量上，而是随数据变化的语义色，
 * 所以集中在 theme 目录统一维护，页面只取函数结果，不写死颜色（AGENTS.md 二·三）。
 * 渐变两端对白字的对比度均 ≥ 4.5:1（WCAG AA），深浅色主题共用同一套天空色。
 */

export type SkyTone = { from: string; to: string }

/** 晴→蓝、多云→蓝灰、阴→中性灰、雨→冷灰、雷→石板紫、雪→冷灰蓝、雾→冷灰、霾→中性暖灰、沙尘→土黄 */
export const SKY_TONES = {
  clear: { from: '#1568bd', to: '#0a4a90' },
  partly: { from: '#457695', to: '#29506c' },
  cloudy: { from: '#566270', to: '#3a444f' },
  rain: { from: '#476073', to: '#2b3d4d' },
  storm: { from: '#464d6d', to: '#2a2f47' },
  snow: { from: '#587089', to: '#38536d' },
  fog: { from: '#59626a', to: '#3c434a' },
  haze: { from: '#5b5a55', to: '#3b3a36' },
  dust: { from: '#6a5c45', to: '#493f2f' }
} satisfies Record<string, SkyTone>

export type SkyKey = keyof typeof SKY_TONES

/**
 * 天气现象 → 天空色。判断顺序按「具体到笼统」：
 * 雷在雨前（雷阵雨），雪在雨前（雨夹雪按雪），雾霾沙尘各自成档，多云在晴前（晴间多云）。
 */
export function skyKey(cond: string): SkyKey {
  const c = String(cond || '').trim()
  if (!c) return 'partly'
  if (/雷/.test(c)) return 'storm'
  if (/雪|霰|冰雹|冻雨/.test(c)) return 'snow'
  if (/雨/.test(c)) return 'rain'
  if (/沙|尘/.test(c)) return 'dust'
  if (/雾/.test(c)) return 'fog'
  if (/霾|烟/.test(c)) return 'haze'
  if (/阴/.test(c)) return 'cloudy'
  if (/多云|少云|晴间|云/.test(c)) return 'partly'
  if (/晴/.test(c)) return 'clear'
  return 'partly'
}

export function skyTone(cond: string): SkyTone {
  return SKY_TONES[skyKey(cond)]
}

/** Hero 背景：左上偏亮、右下偏深，保持和卡片圆角一致的方向感 */
export function heroGradient(cond: string): string {
  const tone = skyTone(cond)
  return 'linear-gradient(135deg, ' + tone.from + ' 0%, ' + tone.to + ' 100%)'
}
