<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import { NTag, NButton, NEmpty, NDrawer, NDrawerContent, useMessage } from 'naive-ui'
import { GridLayout, GridItem } from 'grid-layout-plus'
import Shell from '@/components/Shell.vue'
import WeatherCard from '@/components/home/WeatherCard.vue'
import ScheduleCard from '@/components/home/ScheduleCard.vue'
import TodoCard from '@/components/home/TodoCard.vue'
import PomodoroCard from '@/components/home/PomodoroCard.vue'
import ParcelCard from '@/components/home/ParcelCard.vue'
import FeedCard from '@/components/home/FeedCard.vue'
import MailCard from '@/components/home/MailCard.vue'
import NoticeCard from '@/components/home/NoticeCard.vue'
import { bridge, hasBridge } from '@/lib/ipc'
import { CARD_META, useHomeCards, type CardKey } from '@/composables/useHomeCards'
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
const { cols, gridItems, locked, onGridLayoutUpdated, moveBy, resizeBy, commit, scheduleCommit } = useHomeLayout(shown)
const showCards = ref(false)
const anyCard = computed(() => hiddenCount.value < 8)

/**
 * 拖动只从卡片标题区开始，且避开标题里的按钮、开关、输入框，避免误触。
 * 传给 GridItem 的 drag-ignore-from / resize-ignore-from，语义与库的 dragIgnoreFrom 一致。
 */
const NO_DRAG = 'button, a, input, textarea, select, [role="button"], .n-switch, .n-base-selection, .n-checkbox'

/** 卡片组件映射：卡片组件本身不改，尺寸与坐标全由 GridItem 决定 */
const CARD_VIEWS: Record<CardKey, Component> = {
  weather: WeatherCard,
  schedule: ScheduleCard,
  todo: TodoCard,
  pomodoro: PomodoroCard,
  parcel: ParcelCard,
  feed: FeedCard,
  mail: MailCard,
  notice: NoticeCard
}

// 模板里 LayoutItem.i 的类型是 number | string，取值统一在这里收敛成 CardKey
function cardView(key: string | number): Component {
  return CARD_VIEWS[key as CardKey]
}
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
function onGridPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  pressAt = { x: e.clientX, y: e.clientY }
  pressedMoved = false
}
function onGridPointerMove(e: PointerEvent) {
  if (!pressAt) return
  if (Math.abs(e.clientX - pressAt.x) > 6 || Math.abs(e.clientY - pressAt.y) > 6) pressedMoved = true
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
  }
})
onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
  if (unsubscribe) { unsubscribe(); unsubscribe = null }
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
