<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NTag, NButton, NEmpty, NDrawer, NDrawerContent, useMessage } from 'naive-ui'
import { GridLayout, GridItem } from 'grid-layout-plus'
import Shell from '@/components/Shell.vue'
import { bridge, call, hasBridge } from '@/lib/ipc'
import { cardView } from '@/composables/useCardViews'
import { useWidgets } from '@/composables/useWidgets'
import { CARD_META, ENABLED_CARD_KEYS, useHomeCards, type CardKey } from '@/composables/useHomeCards'
import { CARD_SIZE, GAP_PX, MAX_H, ROW_PX, useHomeLayout } from '@/composables/useHomeLayout'
import { triggerHomeRefresh } from '@/composables/useHomeRefresh'
import CardSettingsPanel from '@/components/home/CardSettingsPanel.vue'
import '@/styles/home.css'

const message = useMessage()
/** 卡片显隐与卡片菜单读同一份设置（见 useHomeCards） */
const { shown, hiddenCount } = useHomeCards()
/**
 * 卡片坐标与尺寸（见 useHomeLayout）：拖动与缩放交给 grid-layout-plus，
 * 它只在拖动/缩放结束时发 layout-updated，我们据此回写设置。
 */
const { cols, gridItems, locked, onGridLayoutUpdated, moveBy, resizeBy, commit, scheduleCommit, revert } = useHomeLayout(shown)
const showCards = ref(false)
const anyCard = computed(() => hiddenCount.value < ENABLED_CARD_KEYS.length)

/**
 * 拖动只从卡片标题区开始，且避开标题里的按钮、开关、输入框，避免误触。
 * 传给 GridItem 的 drag-ignore-from / resize-ignore-from，语义与库的 dragIgnoreFrom 一致。
 */
const NO_DRAG = 'button, a, input, textarea, select, [role="button"], .n-switch, .n-base-selection, .n-checkbox, .hc-pin-tag'

function minH(key: string | number): number {
  return CARD_SIZE[key as CardKey].minH
}
function cellLabel(key: string | number): string {
  return CARD_META[key as CardKey].label + '卡片，方向键移动，Shift 加方向键调整大小'
}

const WEEKS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const now = ref(new Date())
const updatedAt = ref('')
let clock: ReturnType<typeof setInterval> | null = null
let unsubscribe: (() => void) | null = null
let unsubscribeDragOut: (() => void) | null = null

const dateText = computed(() => {
  const d = now.value
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + WEEKS[d.getDay()]
})
const timeText = computed(() => {
  const d = now.value
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
})

/**
 * 刷新走令牌：卡片就地重载，不重挂载，滚动位置与卡片高度都不受影响。
 * 一次写库会连续触发多个广播，合并到下一帧只刷新一次，避免滚动中连续重排。
 * 注意：这是「整页刷新」，只给顶部刷新按钮用；库广播走 refreshCard，只动受影响的那张卡。
 */
let refreshPending = false
function refresh() {
  updatedAt.value = timeText.value
  if (refreshPending) return
  refreshPending = true
  requestAnimationFrame(() => {
    refreshPending = false
    if (document.hidden) return
    triggerHomeRefresh()
  })
}

/**
 * 广播 → 卡片映射：一次写库只重载对应的那张卡。
 * 之前任何非 settings 域都走 refresh()，导致「通知全部已读」把八张卡一起刷新。
 */
const DOMAIN_CARD: Record<string, CardKey | undefined> = {
  todo: 'todo',
  schedule: 'schedule',
  pomodoro: 'pomodoro',
  feed: 'feed',
  parcel: 'parcel',
  mail: 'mail',
  notification: 'notice',
  weather: 'weather'
}

function refreshCard(domain: string) {
  updatedAt.value = timeText.value
  const card = DOMAIN_CARD[domain]
  if (!card) return
  triggerHomeRefresh(card)
}

/* ---------- 交互：拖动结束后吞掉补发的 click ---------- */

/**
 * 卡片标题区本身有点击（跳转模块页）。拖动/缩放结束后浏览器仍会在源元素上补一记 click，
 * 按下后指针位移超过阈值就把它拦掉，避免拖完卡片直接跳页面。
 */
let pressAt: { x: number; y: number } | null = null
let pressedMoved = false
/** 最近一次指针位置：拖出窗口后要合成一记 pointerup 把库的拖动收尾 */
let lastPt = { x: 0, y: 0, sx: 0, sy: 0 }
/** 拖动中的卡片是否已经交给主进程监视光标越界 */
let dragArmed = false

const widgets = useWidgets()

function closestKey(target: EventTarget | null): CardKey | null {
  const node = target as HTMLElement | null
  const host = node && typeof node.closest === 'function' ? node.closest('[data-key]') : null
  const raw = host ? host.getAttribute('data-key') : ''
  return raw ? (raw as CardKey) : null
}

/** 按下的位置是否在卡片标题区（库只允许从 .n-card-header 起拖） */
function headerCard(target: EventTarget | null): CardKey | null {
  const node = target as HTMLElement | null
  if (!node || typeof node.closest !== 'function') return null
  if (node.closest(NO_DRAG)) return null
  const header = node.closest('.n-card-header')
  return header ? closestKey(header) : null
}

function disarmDragWatch() {
  if (!dragArmed) return
  dragArmed = false
  void call(() => window.api.widget.disarmDrag(), false)
}

function onGridPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  pressAt = { x: e.clientX, y: e.clientY }
  lastPt = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY }
  pressedMoved = false
  // 窗口外的 pointermove/pointerup 到不了页面，交给主进程盯真实光标，越界后回推
  const card = locked.value ? null : headerCard(e.target)
  if (card) {
    dragArmed = true
    void call(() => window.api.widget.armDrag({ card }), false)
  }
}
function onGridPointerMove(e: PointerEvent) {
  lastPt = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY }
  if (!pressAt) return
  if (!pressedMoved && (Math.abs(e.clientX - pressAt.x) > 6 || Math.abs(e.clientY - pressAt.y) > 6)) pressedMoved = true
}
function onGridClick(e: MouseEvent) {
  if (!pressedMoved) return
  pressedMoved = false
  pressAt = null
  e.stopPropagation()
  e.preventDefault()
}
function onGridPointerUp() {
  pressAt = null
  disarmDragWatch()
}

/**
 * 补一记 pointerup：光标在窗口外松手时库收不到事件，拖动会一直挂着（卡片粘在边上）。
 * 库的 up 处理在 document 上，bubbles 后的合成事件能正常收尾。
 */
function endStuckDrag() {
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: lastPt.x,
    clientY: lastPt.y,
    screenX: lastPt.sx,
    screenY: lastPt.sy,
    button: 0,
    buttons: 0,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true
  }
  try {
    document.dispatchEvent(new PointerEvent('pointerup', init))
  } catch (e) {
    document.dispatchEvent(new MouseEvent('mouseup', init))
  }
}

/**
 * 卡片被拖出主窗口（主进程轮询真实光标后回推）。
 *
 * 语义是「复制」不是「搬走」：首页这张保持显示、位置回原位，
 * 桌面那份独立存在（widgets 与 modules 两套设置互不影响），所以这里要 revert 掉库改过的坐标。
 */
async function onWidgetDragOut(payload: { card: CardKey }) {
  disarmDragWatch()
  endStuckDrag()
  pressedMoved = false
  // 等库把 dragend 的补发事件处理完，再撤销它算出来的坐标
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  const key = payload && payload.card
  if (!key) return
  const label = CARD_META[key] ? CARD_META[key].label : '卡片'
  const res = await widgets.dropAtCursor(key)
  revert()
  if (!res) return
  if (res.reason === 'ok') {
    message.success(label + '已钉到桌面：可以直接拖动它，右键可置顶或收回')
    return
  }
  if (res.reason === 'exists') message.info('「' + label + '」已经在桌面了，直接拖桌面上那份挪位置就行')
}

/* ---------- 布局：键盘可达（库没有键盘支持，位移仍由这里算） ---------- */

function onCellKey(e: KeyboardEvent, raw: string | number) {
  // 只处理落在外层容器自身的按键，卡片内部输入框/列表不受影响
  if (e.target !== e.currentTarget || locked.value) return
  if (e.key.indexOf('Arrow') !== 0) return
  e.preventDefault()
  const key = raw as CardKey
  if (e.shiftKey) {
    const dw = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
    const dh = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (resizeBy(key, dw, dh)) scheduleCommit()
    return
  }
  const dir = e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowUp' ? 'up' : 'down'
  if (moveBy(key, dir)) scheduleCommit()
}

/* ---------- 落库：拖动过程不写，收尾合并写一次 ---------- */

async function persist() {
  const ok = await commit()
  if (!ok) message.warning('布局保存失败，已恢复上一次的布局')
}

onMounted(() => {
  updatedAt.value = timeText.value
  clock = setInterval(() => { now.value = new Date() }, 30000)
  // 库在挂载时量一次容器宽度；这里再触发一次 resize，保证首帧就按真实宽度定位
  window.dispatchEvent(new Event('resize'))
  if (hasBridge()) {
    // 任一模块写库后只刷新对应的那张卡；settings 域的广播只是布局/外观落库（拖动卡片就会触发），
    // 不能当成数据变化去重载卡片，否则拖完一次全部卡片都闪一遍。离开首页时解绑。
    unsubscribe = bridge().onDataChanged((p) => {
      if (!p || p.domain === 'settings') return
      refreshCard(p.domain)
    })
    // 光标越过窗口边缘 = 这张卡要落到桌面（窗口外收不到 DOM 事件，只能由主进程判定）
    unsubscribeDragOut = bridge().onWidgetDragOut((p) => {
      void onWidgetDragOut(p)
    })
  }
})
onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
  disarmDragWatch()
  if (unsubscribe) { unsubscribe(); unsubscribe = null }
  if (unsubscribeDragOut) { unsubscribeDragOut(); unsubscribeDragOut = null }
})
</script>

<template>
  <Shell>
    <template #subtitle>{{ dateText }} · 数据更新于 {{ updatedAt || timeText }}（本地缓存）</template>
    <template #actions>
      <n-tag v-if="locked" size="small" type="info">布局已锁定</n-tag>
      <span class="hc-status"><i class="hc-dot is-ok" />本地数据</span>
      <span v-if="hiddenCount" class="hc-status"><i class="hc-dot is-warn" />{{ hiddenCount }} 张卡片已隐藏</span>
      <n-button size="medium" @click="showCards = true">卡片设置</n-button>
      <n-button size="medium" @click="refresh">刷新</n-button>
    </template>

    <!-- 拖动排序与缩放由 grid-layout-plus 负责：坐标写回设置，刷新后按设置的坐标还原 -->
    <div v-if="anyCard" class="home-grid-wrap">
      <grid-layout
        class="home-grid"
        :class="{ 'is-locked': locked }"
        :layout="gridItems"
        :col-num="cols"
        :row-height="ROW_PX"
        :margin="[GAP_PX, GAP_PX]"
        :is-draggable="!locked"
        :is-resizable="!locked"
        :auto-size="true"
        :vertical-compact="true"
        @pointerdown.capture="onGridPointerDown"
        @pointermove.capture="onGridPointerMove"
        @pointerup.capture="onGridPointerUp"
        @pointercancel.capture="onGridPointerUp"
        @click.capture="onGridClick"
        @layout-updated="onGridLayoutUpdated"
      >
        <grid-item
          v-for="cell in gridItems"
          :key="cell.i"
          :i="cell.i"
          :x="cell.x"
          :y="cell.y"
          :w="cell.w"
          :h="cell.h"
          :min-w="1"
          :max-w="cols"
          :min-h="minH(cell.i)"
          :max-h="MAX_H"
          drag-allow-from=".n-card-header"
          :drag-ignore-from="NO_DRAG"
          :resize-ignore-from="NO_DRAG"
          :data-key="cell.i"
          tabindex="0"
          role="group"
          :aria-label="cellLabel(cell.i)"
          @keydown="onCellKey($event, cell.i)"
        >
          <component :is="cardView(cell.i)" />
        </grid-item>
      </grid-layout>
    </div>
    <div v-else class="card">
      <n-empty description="首页卡片都被隐藏了">
        <n-button size="small" @click="showCards = true">打开卡片设置</n-button>
      </n-empty>
    </div>

    <n-drawer v-model:show="showCards" :width="420" placement="right">
      <n-drawer-content title="卡片设置" closable :native-scrollbar="false">
        <CardSettingsPanel />
      </n-drawer-content>
    </n-drawer>
  </Shell>
</template>
