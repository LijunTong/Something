<script setup lang="ts">
/**
 * 邮件 HTML 阅读器。
 *
 * 为什么用 iframe：邮件正文自带 <style> 与 div/table 全局选择器，直接 v-html 会把
 * 邮件里的排版规则泄漏到整个应用（连侧栏一起变样）。沙箱 iframe 里渲染既保留原始
 * 排版，又靠 sandbox + CSP 双层禁掉脚本。Naive UI 没有 iframe 容器组件，按
 * AGENTS.md 1.2「组件库无对应组件」允许自写，此处即属该例外。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ html: string; allowRemoteImages: boolean }>()

type Theme = { text: string; muted: string; border: string; primary: string; size: string; font: string }

/** 主题色从 App.vue 注入的 CSS 变量里读，iframe 内没有继承链，必须显式带进去 */
function readTheme(): Theme {
  const cs = typeof window === 'undefined' ? null : getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => {
    const v = cs ? cs.getPropertyValue(name).trim() : ''
    return v || fallback
  }
  return {
    text: read('--text', '#1f2937'),
    muted: read('--muted', '#5f6b7a'),
    border: read('--border', '#e5e7eb'),
    primary: read('--app-primary', '#0f766e'),
    size: read('--fs-12', '13px'),
    font: '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
  }
}

const theme = ref<Theme>(readTheme())

/** 事件属性与可执行标签先摘掉：CSP 与 sandbox 已兜底，这里只减少脏数据 */
function sanitize(html: string): string {
  let out = String(html || '')
  out = out.replace(/<\s*(script|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  out = out.replace(/<\s*(script|iframe|object|embed)\b[^>]*\/?>/gi, '')
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  return out
}

function buildDoc(html: string, allowRemote: boolean, t: Theme): string {
  // 未授权远程图片时只放行内联 data: 图，正文里的 http(s) 图会被 CSP 直接拦掉，不会发出请求
  const imgSrc = allowRemote ? 'http: https: data:' : 'data:'
  const csp = "default-src 'none'; img-src " + imgSrc + "; style-src 'unsafe-inline'; font-src data:; media-src " + imgSrc + ';'
  const base = [
    'html,body{margin:0;padding:0;background:transparent;}',
    'body{color:' + t.text + ';font:' + t.size + '/1.65 ' + t.font + ';overflow-wrap:anywhere;}',
    'img{max-width:100%;height:auto;}',
    'table{max-width:100%;border-collapse:collapse;}',
    'a{color:' + t.primary + ';}',
    'blockquote{margin:8px 0;padding-left:10px;border-left:3px solid ' + t.border + ';color:' + t.muted + ';}',
    'pre{white-space:pre-wrap;overflow-wrap:anywhere;}'
  ].join('')
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">'
    + '<base target="_blank">'
    + '<style>' + base + '</style>'
    + '</head><body>' + sanitize(html) + '</body></html>'
}

const sandbox = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox'
const srcdoc = computed(() => buildDoc(props.html, props.allowRemoteImages, theme.value))

const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(240)
const timers: number[] = []

/** iframe 高度跟正文实际高度走：沙箱禁脚本，父侧直接读 contentDocument 计算 */
function syncHeight() {
  const doc = frame.value?.contentDocument
  if (!doc) return
  const next = Math.max(doc.documentElement ? doc.documentElement.scrollHeight : 0, doc.body ? doc.body.scrollHeight : 0)
  if (next > 0) height.value = next + 4
}

function onLoad() {
  syncHeight()
  // 远程图片是后到的，加载完高度还会变；补几次采样，避免正文被裁掉
  timers.forEach((t) => window.clearTimeout(t))
  timers.length = 0
  ;[80, 260, 800, 1600].forEach((delay) => timers.push(window.setTimeout(syncHeight, delay)))
}

let observer: MutationObserver | null = null
onMounted(() => {
  if (typeof MutationObserver === 'undefined') return
  // 深浅色切换时 App.vue 重写 <html> 的内联变量，这里跟着重建文档，保持阅读区配色一致
  observer = new MutationObserver(() => { theme.value = readTheme() })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
})
onBeforeUnmount(() => {
  timers.forEach((t) => window.clearTimeout(t))
  if (observer) observer.disconnect()
})
</script>

<template>
  <iframe
    ref="frame"
    class="mail-frame"
    title="邮件正文"
    :sandbox="sandbox"
    :srcdoc="srcdoc"
    :style="{ height: height + 'px' }"
    referrerpolicy="no-referrer"
    @load="onLoad"
  />
</template>
