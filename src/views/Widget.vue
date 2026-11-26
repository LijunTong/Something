<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NDropdown, NEmpty, NTag, type DropdownOption } from 'naive-ui'
import { cardView, isCardKey } from '@/composables/useCardViews'
import { provideWidgetContext, type WidgetContext } from '@/lib/widgetContext'
import { call, hasBridge } from '@/lib/ipc'
import { useSettings } from '@/composables/useSettings'
import type { WidgetBoundsResult, WidgetItem, WidgetListResult } from '@/types/api'
import '@/styles/widget.css'

/**
 * 桌面挂件窗口的渲染入口。
 *
 * 这个窗口由 electron/widget.cjs 用「同一个 dist + hash 路由 /widget/<card>」拉起，
 * 因此和主窗口共享组件与主题，但**不能**就地跳转：一次 push 会把挂件窗口变成整页应用。
 * 所以这里挂一个路由守卫，把卡片内部的跳转转给主窗口（widget.navigateMain）。
 *
 * 拖动/缩放不用 -webkit-app-region（透明窗口在 Windows 上会拖影），
 * 改为自绘把手 + IPC 逐帧改窗口 bounds，坐标由主进程钳制。
 */

const route = useRoute()
const router = useRouter()
const { settings } = useSettings()

const card = computed(() => String(route.params.card || ''))
const cardOk = computed(() => isCardKey(card.value))
const widgetId = computed(() => String(route.query.id || 'w-' + card.value))
const item = ref<WidgetItem | null>(null)
const dragging = ref(false)
/** 正在拖右下角/边缩放：这段时间给整窗铺一层不透明底，压掉透明窗口改尺寸时的黑边 */
const sizing = ref(false)
let sizeTimer = 0
const menuShow = ref(false)
const menuX = ref(0)
const menuY = ref(0)

/** useTransparent=false：透明窗口合成异常时，整窗铺一层 surface 兜底 */
const opaque = computed(() => settings.value.widgets?.useTransparent === false)
const locked = computed(() => (item.value ? item.value.locked : false))

/** 尺寸下限与主进程 electron/widget.cjs 的 MIN_W/MIN_H 一致；最终值仍由主进程钳制 */
const MIN_W = 260
const MIN_H = 220
const DEFAULT_W = 360
const DEFAULT_H = 340

/** 卡片 → 模块页：挂件里点标题或内容时把主窗口导航过去 */
const CARD_PATH: Record<string, string> = {
  weather: '/weather',
  schedule: '/schedule',
  todo: '/todo',
  pomodoro: '/pomodoro',
  feed: '/feed',
  parcel: '/parcel',
  mail: '/mail',
  notice: '/notice'
}

/* ---------- 窗口几何：本地镜像 + rAF 合帧 ---------- */

const winRect = ref({ x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H })
let rectFrame = 0
let pendingRect: { x: number; y: number; w: number; h: number } | null = null

function flushRect() {
  rectFrame = 0
  const next = pendingRect
  pendingRect = null
  if (!next) return
  winRect.value = { ...next }
  void call(
    () => window.api.widget.setBounds({ id: widgetId.value, x: next.x, y: next.y, w: next.w, h: next.h }),
    null as WidgetBoundsResult | null
  )
    .then((res) => {
      if (!res) return
      noteClamp(res)
      // 手势结束了就以主进程实际生效的几何为准：贴边被夹住时本地值不能继续漂
      if (!dragBase && !sizeBase) {
        winRect.value = { x: res.x, y: res.y, w: res.width, h: res.height }
      }
    })
    .catch(() => {})
}

/**
 * 贴边提示：窗口被屏幕边界夹住时给一句话，别让用户以为卡死了。
 * 同一次拖动里同一个方向只提示一次，换到另一边才再提示。
 */
const edgeHint = ref('')
let hintTimer = 0
let lastHintKey = ''
let lastHintAt = 0

function noteClamp(res: WidgetBoundsResult) {
  const c = res.clamped
  if (!c || (!c.x && !c.y && !c.w && !c.h)) return
  const key = (c.x ? 'x' : '') + (c.y ? 'y' : '') + (c.w ? 'w' : '') + (c.h ? 'h' : '')
  if (key === lastHintKey && Date.now() - lastHintAt < 2500) return
  lastHintKey = key
  lastHintAt = Date.now()
  edgeHint.value = c.w || c.h ? '已经到屏幕放得下的最大尺寸' : '已经贴到屏幕边缘'
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    edgeHint.value = ''
    hintTimer = 0
  }, 1600)
}

/** 手势结束后把本地几何对齐到主进程：贴边被夹过时本地值会偏 */
async function syncBounds() {
  const b = await call(
    () => window.api.widget.bounds({ id: widgetId.value }),
    null as { x: number; y: number; width: number; height: number } | null
  )
  if (b) winRect.value = { x: b.x, y: b.y, w: b.width, h: b.height }
}

function scheduleRect(rect: { x: number; y: number; w: number; h: number }) {
  pendingRect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h)
  }
  if (rectFrame) return
  rectFrame = requestAnimationFrame(flushRect)
}

/* ---------- 拖动：卡片标题区当把手 ---------- */

/** 与首页 Home.vue 的 NO_DRAG 同一份名单：按在这些上面不启动窗口拖动 */
const NO_DRAG = 'button, a, input, textarea, select, [role="button"], .n-switch, .n-base-selection, .n-checkbox, .widget-handle'

let dragBase: { px: number; py: number; x: number; y: number } | null = null

function onShellPointerDown(e: PointerEvent) {
  if (e.button !== 0 || locked.value) return
  const el = e.target as HTMLElement | null
  if (!el || el.closest(NO_DRAG)) return
  // 只有卡片标题区可以起拖，和首页 drag-allow-from=".n-card-header" 保持一致
  if (!el.closest('.n-card-header')) return
  dragBase = { px: e.screenX, py: e.screenY, x: winRect.value.x, y: winRect.value.y }
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function onShellPointerMove(e: PointerEvent) {
  if (!dragBase) return
  scheduleRect({
    x: dragBase.x + (e.screenX - dragBase.px),
    y: dragBase.y + (e.screenY - dragBase.py),
    w: winRect.value.w,
    h: winRect.value.h
  })
}

function onShellPointerUp(e: PointerEvent) {
  if (!dragBase) return
  dragBase = null
  dragging.value = false
  const host = e.currentTarget as HTMLElement | null
  if (host && host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
  void syncBounds()
}

/* ---------- 缩放：四边 + 四角 ---------- */

let sizeBase: { px: number; py: number; rect: { x: number; y: number; w: number; h: number }; dir: string } | null = null

function onHandleDown(e: PointerEvent, dir: string) {
  if (e.button !== 0 || locked.value) return
  e.stopPropagation()
  e.preventDefault()
  const r = winRect.value
  sizeBase = { px: e.screenX, py: e.screenY, rect: { x: r.x, y: r.y, w: r.w, h: r.h }, dir }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  sizing.value = true
}

function onHandleMove(e: PointerEvent) {
  if (!sizeBase) return
  const dx = e.screenX - sizeBase.px
  const dy = e.screenY - sizeBase.py
  const r = sizeBase.rect
  let x = r.x
  let y = r.y
  let w = r.w
  let h = r.h
  if (sizeBase.dir.indexOf('e') >= 0) w = r.w + dx
  if (sizeBase.dir.indexOf('s') >= 0) h = r.h + dy
  if (sizeBase.dir.indexOf('w') >= 0) {
    w = r.w - dx
    x = r.x + dx
  }
  if (sizeBase.dir.indexOf('n') >= 0) {
    h = r.h - dy
    y = r.y + dy
  }
  // 到最小尺寸就停手：从左边/上边拉时左上角也要跟着停住，否则窗口会越缩越偏
  if (w < MIN_W) {
    if (sizeBase.dir.indexOf('w') >= 0) x = r.x + (r.w - MIN_W)
    w = MIN_W
  }
  if (h < MIN_H) {
    if (sizeBase.dir.indexOf('n') >= 0) y = r.y + (r.h - MIN_H)
    h = MIN_H
  }
  scheduleRect({ x, y, w, h })
}

function onHandleUp(e: PointerEvent) {
  if (!sizeBase) return
  sizeBase = null
  sizeFrameCleanup(e)
  // 缩放手势结束后再留 160ms 不透明底：最后几帧的重绘最容易露出黑边
  if (sizeTimer) clearTimeout(sizeTimer)
  sizeTimer = window.setTimeout(() => {
    sizing.value = false
    sizeTimer = 0
  }, 160)
  void syncBounds()
}

function sizeFrameCleanup(e: PointerEvent) {
  const host = e.currentTarget as HTMLElement | null
  if (host && host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
}

/* ---------- 数据 ---------- */

async function reload() {
  const res: WidgetListResult = await call(
    () => window.api.widget.list(),
    { items: [] as WidgetItem[], max: 0, live: 0 }
  )
  item.value = res.items.find((it) => it.id === widgetId.value) || null
}

async function applyPatch(patch: { alwaysOnTop?: boolean; locked?: boolean }) {
  const next = await call(
    () => window.api.widget.patch({ id: widgetId.value, patch }),
    null as WidgetItem | null
  )
  if (next) item.value = next
}

async function closeWidget() {
  menuShow.value = false
  // 主进程会直接销毁这个窗口，invoke 的返回值不一定能回来，所以不依赖它
  await call(() => window.api.widget.remove({ id: widgetId.value }), false)
}

async function openInApp(path: string) {
  const to = path || CARD_PATH[card.value]
  if (!to) return
  if (!hasBridge()) {
    void router.push(to)
    return
  }
  await call(() => window.api.widget.navigateMain({ to }), false)
}

async function resetSize() {
  menuShow.value = false
  const r = winRect.value
  scheduleRect({ x: r.x, y: r.y, w: DEFAULT_W, h: DEFAULT_H })
}

/* ---------- 右键菜单 ---------- */

const menuOptions = computed<DropdownOption[]>(() => [
  {
    key: 'top',
    label: item.value?.alwaysOnTop ? '取消总在最前' : '总在最前'
  },
  {
    key: 'lock',
    label: locked.value ? '解锁位置与大小' : '锁定位置与大小'
  },
  { key: 'size', label: '恢复默认大小' },
  { key: 'd1', type: 'divider' },
  {
    key: 'open',
    label: '在仪表盘打开',
    disabled: !CARD_PATH[card.value]
  },
  { key: 'd2', type: 'divider' },
  { key: 'close', label: '收回桌面卡片' }
])

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  menuX.value = e.clientX
  menuY.value = e.clientY
  menuShow.value = true
}

function onMenuSelect(key: string) {
  if (key === 'top') void applyPatch({ alwaysOnTop: !(item.value?.alwaysOnTop === true) })
  if (key === 'lock') void applyPatch({ locked: !locked.value })
  if (key === 'size') void resetSize()
  if (key === 'open') void openInApp(CARD_PATH[card.value])
  if (key === 'close') void closeWidget()
  menuShow.value = false
}

/* ---------- 给卡片组件的上行上下文 ---------- */

const ctx = reactive<WidgetContext>({
  id: widgetId.value,
  card: card.value,
  alwaysOnTop: false,
  locked: false,
  close: () => {
    void closeWidget()
  },
  toggleAlwaysOnTop: () => {
    void applyPatch({ alwaysOnTop: !(item.value?.alwaysOnTop === true) })
  },
  openInApp: (path: string) => {
    void openInApp(path)
  }
})
provideWidgetContext(ctx)

watch(
  item,
  (next) => {
    ctx.alwaysOnTop = next ? next.alwaysOnTop : false
    ctx.locked = next ? next.locked : false
  },
  { immediate: true }
)

/* ---------- 生命周期 ---------- */

let removeGuard: (() => void) | null = null
let unsubscribe: (() => void) | null = null

onMounted(() => {
  document.documentElement.classList.add('is-widget')
  // 卡片里的 router.push 一律转给主窗口：挂件窗口只显示这一张卡
  removeGuard = router.beforeEach((to) => {
    if (to.name === 'widget') return true
    void openInApp(to.fullPath)
    return false
  })
  void (async () => {
    await reload()
    const b = await call(
      () => window.api.widget.bounds({ id: widgetId.value }),
      null as { x: number; y: number; width: number; height: number } | null
    )
    if (b) winRect.value = { x: b.x, y: b.y, w: b.width, h: b.height }
  })()
  if (hasBridge()) {
    unsubscribe = window.api.onDataChanged((p) => {
      if (!p || p.domain !== 'widget') return
      void reload()
    })
  }
})

onBeforeUnmount(() => {
  document.documentElement.classList.remove('is-widget')
  if (removeGuard) removeGuard()
  if (unsubscribe) unsubscribe()
  if (rectFrame) cancelAnimationFrame(rectFrame)
  if (hintTimer) clearTimeout(hintTimer)
  if (sizeTimer) clearTimeout(sizeTimer)
})
</script>

<template>
  <div
    class="widget-shell"
    :class="{ 'is-dragging': dragging, 'is-sized': sizing, 'is-locked': locked, 'is-opaque': opaque }"
    @pointerdown="onShellPointerDown"
    @pointermove="onShellPointerMove"
    @pointerup="onShellPointerUp"
    @pointercancel="onShellPointerUp"
    @contextmenu="onContextMenu"
  >
    <div class="widget-body">
      <component :is="cardView(card)" v-if="cardOk" />
      <n-empty v-else description="这张卡片不认识" />
    </div>

    <!-- 贴边/到尺寸上限提示：只给一句话，不打断拖动 -->
    <div v-if="edgeHint" class="widget-hint">
      <n-tag size="small" type="warning" :bordered="false">{{ edgeHint }}</n-tag>
    </div>

    <!-- 缩放手柄：锁定时不出现，避免误拉 -->
    <template v-if="!locked">
      <span class="widget-handle widget-handle-n" @pointerdown="onHandleDown($event, 'n')" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp" />
      <span class="widget-handle widget-handle-s" @pointerdown="onHandleDown($event, 's')" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp" />
      <span class="widget-handle widget-handle-e" @pointerdown="onHandleDown($event, 'e')" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp" />
      <span class="widget-handle widget-handle-w" @pointerdown="onHandleDown($event, 'w')" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp" />
      <span class="widget-handle widget-handle-ne" @pointerdown="onHandleDown($event, 'ne')" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp" />
      <span class="widget-handle widget-handle-nw" @pointerdown="onHandleDown($event, 'nw')" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp" />
      <span class="widget-handle widget-handle-se" @pointerdown="onHandleDown($event, 'se')" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp" />
      <span class="widget-handle widget-handle-sw" @pointerdown="onHandleDown($event, 'sw')" @pointermove="onHandleMove" @pointerup="onHandleUp" @pointercancel="onHandleUp" />
    </template>

    <n-dropdown
      trigger="manual"
      placement="bottom-start"
      :show="menuShow"
      :x="menuX"
      :y="menuY"
      :options="menuOptions"
      @select="onMenuSelect"
      @clickoutside="menuShow = false"
    />
  </div>
</template>
