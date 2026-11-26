import { computed, ref } from 'vue'
import { bridge, call, hasBridge } from '@/lib/ipc'
import type { WidgetDropResult, WidgetItem, WidgetListResult } from '@/types/api'
import type { CardKey } from '@/composables/useHomeCards'

/**
 * 桌面挂件状态（首页角标、卡片菜单、设置页共用）。
 *
 * 真相在主进程：这里只读 widget:list，写操作全部调 IPC，
 * 结果靠主进程的 widget:changed 广播回流——不要把 items 当成可随意改的本地数组。
 */
const items = ref<WidgetItem[]>([])
const maxCount = ref(6)
const loading = ref(false)
let attached = false

function attach() {
  if (attached || !hasBridge()) return
  attached = true
  // 挂件增删/改置顶都会广播 widget:changed，这里跟着重拉一次
  bridge().onDataChanged((p) => {
    if (p && p.domain === 'widget') void refresh()
  })
}

async function refresh(): Promise<void> {
  if (!hasBridge()) {
    items.value = []
    return
  }
  loading.value = true
  try {
    const res: WidgetListResult = await call(
      () => window.api.widget.list(),
      { items: [] as WidgetItem[], max: 6, live: 0 }
    )
    items.value = res.items
    maxCount.value = res.max || 6
  } finally {
    loading.value = false
  }
}

/** 首页松手时调：是否落在窗口外由主进程用真实光标坐标判定 */
async function dropAtCursor(card: CardKey): Promise<WidgetDropResult | null> {
  const res = await call(
    () => window.api.widget.dropAtCursor({ card }),
    null as WidgetDropResult | null
  )
  if (res && res.created) void refresh()
  return res
}

/** 菜单入口：直接钉到主屏右上角 */
async function pin(card: CardKey): Promise<WidgetDropResult | null> {
  const res = await call(
    () => window.api.widget.create({ card }),
    null as WidgetDropResult | null
  )
  if (res && res.created) void refresh()
  return res
}

async function unpin(card: CardKey): Promise<boolean> {
  const it = widgetFor(card)
  if (!it) return false
  const ok = await call(() => window.api.widget.remove({ id: it.id }), false)
  if (ok) void refresh()
  return ok
}

async function unpinAll(): Promise<boolean> {
  const ok = await call(() => window.api.widget.removeAll(), false)
  if (ok) void refresh()
  return ok
}

async function patchWidget(id: string, patch: { alwaysOnTop?: boolean; locked?: boolean }): Promise<WidgetItem | null> {
  const next = await call(() => window.api.widget.patch({ id, patch }), null as WidgetItem | null)
  if (next) void refresh()
  return next
}

function widgetFor(card: CardKey): WidgetItem | null {
  return items.value.find((it) => it.card === card) || null
}

export function useWidgets() {
  attach()
  const pinnedCards = computed(() => items.value.map((it) => it.card as CardKey))
  const count = computed(() => items.value.length)
  const isAtLimit = computed(() => items.value.length >= maxCount.value)

  function isPinned(card: CardKey): boolean {
    return pinnedCards.value.indexOf(card) >= 0
  }

  async function togglePin(card: CardKey) {
    if (isPinned(card)) return unpin(card)
    return pin(card)
  }

  return {
    items,
    loading,
    maxCount,
    count,
    pinnedCards,
    isAtLimit,
    isPinned,
    widgetFor,
    refresh,
    pin,
    unpin,
    unpinAll,
    patchWidget,
    dropAtCursor,
    togglePin
  }
}

// 首个调用者挂载时拉一次，之后靠广播
export function initWidgets(): void {
  attach()
  if (!items.value.length) void refresh()
}
