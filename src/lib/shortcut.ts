// 快捷键匹配：统一的组合键生成与比较，支持 Ctrl+1-2 这样的区间写法。
export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  const code = e.code || ''
  let key = e.key
  if (code.startsWith('Key')) key = code.slice(3)
  else if (code.startsWith('Digit')) key = code.slice(5)
  else if (code === 'Space' || key === ' ') key = 'Space'
  if (key && ['Control', 'Alt', 'Shift', 'Meta'].indexOf(key) < 0) parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}

/** 正在输入框里打字时不触发全局快捷键 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = String(el.tagName || '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

export function matchesCombo(e: KeyboardEvent, combo: string | undefined | null): boolean {
  const want = String(combo || '').trim()
  if (!want) return false
  const actual = comboOf(e)
  if (actual === want) return true
  const parts = want.split('+')
  const lastPart = parts[parts.length - 1]
  const range = /^(\d)-(\d)$/.exec(lastPart)
  if (!range) return false
  const actualParts = actual.split('+')
  if (actualParts.length !== parts.length) return false
  if (parts.slice(0, -1).join('+') !== actualParts.slice(0, -1).join('+')) return false
  const n = Number(actualParts[actualParts.length - 1])
  return n >= Number(range[1]) && n <= Number(range[2])
}
