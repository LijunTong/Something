// 深链定位：仪表盘卡片点「某一条」时跳转到对应页面并带上 ?focus=<id>。
// 落地页用本组合式读取 focus，把目标行滚到视口中间、加临时底色、顶部给一条自动消失的提示，
// 这样用户一眼能看出「点的是哪条数据」，而不是落在一个看不出重点的列表首页。
import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export type FocusHintType = 'info' | 'warning'

export interface FocusHint {
  type: FocusHintType
  text: string
}

export interface FocusRuntime {
  /** 从 ?focus= 读到的目标 id，空串表示本次进入不是深链 */
  focusId: Ref<string>
  /** 从 ?at= 读到的时间戳（日程重复实例定位用），空串表示不区分实例 */
  focusAt: Ref<string>
  /** 顶部提示条内容；null 表示不显示 */
  hint: Ref<FocusHint | null>
  /** 当前需要高亮的行 id；空串表示无 */
  highlight: Ref<string>
  /** 数据就绪后调用：滚动到目标行、加高亮、出提示条 */
  locate: (id: string, text: string, at?: string) => Promise<void>
  /** 目标已不存在：换 warning 提示，列表照常可用 */
  miss: (text?: string) => void
  /** 手动关掉提示条与高亮，并把 ?focus 从地址栏抹掉 */
  dismiss: () => void
}

/** 提示条与高亮的存活时间：够看清，又不长期占位 */
const FOCUS_TTL = 4000

/** 行容器的定位属性统一用 data-focus-id / data-focus-at，避免各页面各写一套选择器 */
export function focusSelector(id: string, at?: string): string {
  const key = escapeAttr(id)
  const base = '[data-focus-id="' + key + '"]'
  return at ? base + '[data-focus-at="' + escapeAttr(at) + '"]' : base
}

function escapeAttr(v: string): string {
  // 通知 id 里带冒号（todo:xxx）、时间戳带连字符，都不需要额外处理，只挡引号与反斜杠
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function useFocusQuery(): FocusRuntime {
  const route = useRoute()
  const router = useRouter()
  const focusId = ref(String(route.query.focus || ''))
  const focusAt = ref(String(route.query.at || ''))
  const hint = ref<FocusHint | null>(null)
  const highlight = ref('')
  let timer: number | null = null

  function stopTimer(): void {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  /** 提示条与高亮一起到期：避免只剩一条没有出处的提示挂在页面上 */
  function armTtl(): void {
    stopTimer()
    timer = window.setTimeout(function () {
      hint.value = null
      highlight.value = ''
      timer = null
    }, FOCUS_TTL)
  }

  async function locate(id: string, text: string, at?: string): Promise<void> {
    const key = String(id || '')
    if (!key) return
    highlight.value = key
    hint.value = { type: 'info', text: text }
    armTtl()
    // 列表过滤、抽屉动画都要一帧以上才稳定，太早量 DOM 会滚到错误位置
    await nextTick()
    await new Promise<void>(function (resolve) { window.requestAnimationFrame(function () { resolve() }) })
    const el = (document.querySelector(focusSelector(key, at)) ||
      document.querySelector(focusSelector(key))) as HTMLElement | null
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function miss(text?: string): void {
    highlight.value = ''
    hint.value = { type: 'warning', text: text || '这条数据已不存在，已打开列表页' }
    armTtl()
  }

  function dismiss(): void {
    stopTimer()
    hint.value = null
    highlight.value = ''
    if (!route.query.focus) return
    const query = { ...route.query }
    delete query.focus
    delete query.at
    void router.replace({ path: route.path, query: query })
  }

  // 同一页面里再点另一条（组件被复用）时也要重新定位
  watch(function () { return String(route.query.focus || '') }, function (v) {
    focusId.value = String(v || '')
    focusAt.value = String(route.query.at || '')
  })

  onBeforeUnmount(stopTimer)

  return { focusId: focusId, focusAt: focusAt, hint: hint, highlight: highlight, locate: locate, miss: miss, dismiss: dismiss }
}
