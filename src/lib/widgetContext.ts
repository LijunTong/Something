import { inject, provide, type InjectionKey } from 'vue'

/**
 * 挂件上下文：同一批卡片组件既渲染在首页网格里，也渲染在桌面挂件窗口里。
 * 卡片组件不该去读 location.hash 判断自己在哪，用 provide/inject 往下传，
 * 需要区分时 inject 一下即可（返回 null 就表示「我在首页」）。
 */
export interface WidgetContext {
  /** 挂件 id，形如 w-todo */
  id: string
  card: string
  /** 总在最前 */
  alwaysOnTop: boolean
  /** 锁定后不显示拖动/缩放手感 */
  locked: boolean
  /** 收回这个挂件（只关浮窗，不动首页卡片） */
  close: () => void
  toggleAlwaysOnTop: () => void
  /** 在仪表盘里打开对应模块页 */
  openInApp: (path: string) => void
}

const WIDGET_KEY: InjectionKey<WidgetContext> = Symbol('tk-widget')

export function provideWidgetContext(ctx: WidgetContext): void {
  provide(WIDGET_KEY, ctx)
}

/** 卡片组件用它判断自己是否在挂件里；不在挂件里返回 null */
export function useWidgetContext(): WidgetContext | null {
  return inject(WIDGET_KEY, null)
}

export function inWidget(): boolean {
  return useWidgetContext() !== null
}
