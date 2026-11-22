// 首页卡片布局：网格坐标 + 宽高，唯一事实来源是设置里的 home 分区。
// 拖动与缩放由 grid-layout-plus 负责（见 Home.vue），这里只做数据归一化、二维装箱、
// 落库与键盘位移；不再自己处理 pointer 事件。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSettings } from '@/composables/useSettings'
import { log } from '@/lib/logger'
import { CARD_KEYS, type CardKey } from '@/composables/useHomeCards'
import type { HomeCardLayout, HomeSetting } from '@/types/api'
import type { LayoutItem } from 'grid-layout-plus'

/** 与 Home.vue 传给 GridLayout 的 row-height / margin 保持一致：行高 40px、间距 16px */
export const ROW_PX = 40
export const GAP_PX = 16
/** 卡片高度上限（网格行数） */
export const MAX_H = 12
/** 规范布局的列数（窗口变窄只收窄显示宽度，不改规范布局） */
export const MAX_COLS = 3
/** 断点：≤1180px 两列，≤860px 单列 */
const COL_BREAK_2 = 1180
const COL_BREAK_1 = 860
/** 装箱搜索的最大行数，防止坏数据把循环拖死 */
const PACK_MAX_Y = 200

interface SizeSpec { w: number; h: number; minH: number }

/**
 * 每张卡的默认尺寸与高度下限（单位网格）。
 * 默认 h=6 即 6*40+5*16=320px；minH 防止缩到内容完全不可用，超出的内容在卡片内部滚动。
 */
export const CARD_SIZE: Record<CardKey, SizeSpec> = {
  weather: { w: 1, h: 6, minH: 5 },
  schedule: { w: 2, h: 6, minH: 5 },
  todo: { w: 1, h: 6, minH: 5 },
  // 番茄钟与其余卡片统一：默认 6 行，最小 5 行（内容已压到 5 行内装得下，不会再出滚动条）
  pomodoro: { w: 1, h: 6, minH: 5 },
  parcel: { w: 1, h: 6, minH: 5 },
  feed: { w: 1, h: 6, minH: 4 },
  mail: { w: 2, h: 6, minH: 5 },
  notice: { w: 1, h: 5, minH: 4 }
}

function intOr(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 默认布局顺序（坐标由 packLayout 生成） */
export function defaultOrder(): { key: CardKey; w: number; h: number }[] {
  return CARD_KEYS.map((key) => ({ key, w: CARD_SIZE[key].w, h: CARD_SIZE[key].h }))
}

interface Box { key: CardKey; w: number; h: number; x?: number; y?: number }

/**
 * 二维装箱：按数组顺序逐张落位；已带合法坐标的卡保持原位，冲突或越界的卡落到第一个空位。
 * 同一份输入永远得到同一份输出，所以默认布局、旧数据升级、恢复默认三者结果一致。
 */
export function packLayout(items: Box[], cols: number = MAX_COLS): HomeCardLayout[] {
  const rows: boolean[][] = []
  const ensure = (y: number) => {
    while (rows.length <= y) rows.push(new Array(cols).fill(false))
  }
  const fits = (x: number, y: number, w: number, h: number): boolean => {
    if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > cols) return false
    for (let yy = y; yy < y + h; yy++) {
      ensure(yy)
      for (let xx = x; xx < x + w; xx++) if (rows[yy][xx]) return false
    }
    return true
  }
  const fill = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) {
      ensure(yy)
      for (let xx = x; xx < x + w; xx++) rows[yy][xx] = true
    }
  }
  const firstFree = (w: number, h: number): { x: number; y: number } => {
    for (let y = 0; y < PACK_MAX_Y; y++) {
      for (let x = 0; x + w <= cols; x++) if (fits(x, y, w, h)) return { x, y }
    }
    return { x: 0, y: rows.length }
  }

  const out: HomeCardLayout[] = []
  for (const it of items) {
    const w = clamp(intOr(it.w, 1), 1, Math.min(MAX_COLS, cols))
    const h = clamp(intOr(it.h, 1), 1, MAX_H)
    const bx = typeof it.x === 'number' ? intOr(it.x, 0) : NaN
    const by = typeof it.y === 'number' ? intOr(it.y, 0) : NaN
    const at = Number.isFinite(bx) && Number.isFinite(by) && fits(bx, by, w, h)
      ? { x: bx, y: by }
      : firstFree(w, h)
    fill(at.x, at.y, w, h)
    out.push({ key: it.key, x: at.x, y: at.y, w, h })
  }
  return out
}

/** 默认布局：顺序与改造前的模板一致 */
export function defaultLayout(): HomeCardLayout[] {
  return packLayout(defaultOrder(), MAX_COLS)
}

/**
 * 归一化：丢掉未知/重复 key、补齐缺失 key、夹取宽高与坐标。
 * 旧版本数据只有 {key,w,h}，这里会补出坐标；越界或重叠的坐标交给 packLayout 重新落位。
 */
export function normalizeLayout(raw: unknown): HomeCardLayout[] {
  const seen = new Set<string>()
  const boxes: Box[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const key = (item as HomeCardLayout).key
      if (typeof key !== 'string' || (CARD_KEYS as readonly string[]).indexOf(key) < 0) continue
      if (seen.has(key)) continue
      seen.add(key)
      const k = key as CardKey
      boxes.push({
        key: k,
        // 落库的 w 上限固定 3：窗口变窄只影响显示宽度，不回写设置
        w: clamp(intOr((item as HomeCardLayout).w, CARD_SIZE[k].w), 1, MAX_COLS),
        h: clamp(intOr((item as HomeCardLayout).h, CARD_SIZE[k].h), CARD_SIZE[k].minH, MAX_H),
        x: typeof (item as HomeCardLayout).x === 'number' ? (item as HomeCardLayout).x : undefined,
        y: typeof (item as HomeCardLayout).y === 'number' ? (item as HomeCardLayout).y : undefined
      })
    }
  }
  for (const key of CARD_KEYS) if (!seen.has(key)) boxes.push({ key, w: CARD_SIZE[key].w, h: CARD_SIZE[key].h })
  return packLayout(boxes, MAX_COLS)
}

export function useHomeLayout(isVisible: (key: CardKey) => boolean) {
  const { settings, save } = useSettings()
  const cols = ref(MAX_COLS)
  const layout = ref<HomeCardLayout[]>(normalizeLayout(settings.value.home && settings.value.home.layout))
  /** 上一次成功落库的布局，保存失败时用它回滚 */
  let persisted: HomeCardLayout[] = clone(layout.value)

  const locked = computed(() => settings.value.home && settings.value.home.locked === true)

  /** 交给 GridLayout 的二维布局：只含可见卡，宽度按当前列数收窄（库渲染时也会夹，这里先夹一次） */
  const gridItems = computed<LayoutItem[]>(() =>
    layout.value
      .filter((i) => isVisible(i.key))
      .map((i) => {
        const w = clamp(i.w, 1, cols.value)
        return { i: i.key, x: clamp(i.x, 0, cols.value - w), y: Math.max(0, i.y), w, h: i.h }
      })
  )

  function clone(v: HomeCardLayout[]): HomeCardLayout[] {
    return JSON.parse(JSON.stringify(v)) as HomeCardLayout[]
  }

  /** 列数刚变化后的静默期截止时间：这段时间里库的回写是响应式重排，不是用户拖动 */
  let suppressUntil = 0
  const RESIZE_SUPPRESS_MS = 600

  function readCols() {
    const w = window.innerWidth
    const next = w <= COL_BREAK_1 ? 1 : w <= COL_BREAK_2 ? 2 : MAX_COLS
    if (next === cols.value) return
    cols.value = next
    suppressUntil = Date.now() + RESIZE_SUPPRESS_MS
  }

  onMounted(() => {
    readCols()
    window.addEventListener('resize', readCols)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', readCols)
    if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = null }
  })

  // 设置异步加载完成（或外部改库）后把布局同步进来；内容相同则不覆盖，避免打断拖动
  watch(
    () => settings.value.home,
    (v) => {
      const next = normalizeLayout(v && v.layout)
      if (JSON.stringify(next) === JSON.stringify(layout.value)) return
      layout.value = next
      persisted = clone(next)
    },
    { deep: true }
  )

  function item(key: CardKey): HomeCardLayout | null {
    return layout.value.find((i) => i.key === key) || null
  }

  /**
   * 库的 layout-updated 只带可见卡；隐藏卡的坐标保留在设置里。
   *
   * 关键防护：grid-layout-plus 在 col-num 变化（窗口跨断点）时也会 emit layout-updated，
   * 载荷是「窄列空间里重排后的坐标」，不是用户意图。若把它写回 layout 并落库，等于
   * 「把窗口拉窄」永久改写用户的首页布局，而且拉回宽窗口不会恢复（已实测复现）。
   * 因此列数变化后的静默期内一律不接受回写（显示照旧由库重排，只是不落库）。
   */
  function onGridLayoutUpdated(next: LayoutItem[]) {
    if (Date.now() < suppressUntil) return
    let changed = false
    for (const it of next) {
      const cur = typeof it.i === 'string' ? item(it.i as CardKey) : null
      if (!cur) continue
      if (cur.x !== it.x || cur.y !== it.y || cur.w !== it.w || cur.h !== it.h) {
        cur.x = it.x
        cur.y = it.y
        cur.w = it.w
        cur.h = it.h
        changed = true
      }
    }
    if (changed) scheduleCommit()
  }

  /** 键盘位移：方向键换格子，Shift 改尺寸（库没有键盘支持） */
  function moveBy(key: CardKey, dir: 'left' | 'right' | 'up' | 'down'): boolean {
    const it = item(key)
    if (!it) return false
    const w = clamp(it.w, 1, cols.value)
    if (dir === 'left' || dir === 'right') {
      const nx = clamp(it.x + (dir === 'left' ? -1 : 1), 0, cols.value - w)
      if (nx === it.x) return false
      it.x = nx
    } else {
      const ny = Math.max(0, it.y + (dir === 'up' ? -1 : 1))
      if (ny === it.y) return false
      it.y = ny
    }
    return true
  }

  function resizeBy(key: CardKey, dw: number, dh: number): boolean {
    const it = item(key)
    if (!it) return false
    const w = clamp(it.w + dw, 1, cols.value)
    const h = clamp(it.h + dh, CARD_SIZE[key].minH, MAX_H)
    if (w === it.w && h === it.h) return false
    it.w = w
    it.h = h
    it.x = clamp(it.x, 0, cols.value - w)
    return true
  }

  /** 落库：拖动/缩放结束与键盘操作后用 300ms 防抖合并；内容没变直接跳过 */
  let saveTimer: number | null = null
  function scheduleCommit() {
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      void commit()
    }, 300)
  }

  async function commit(): Promise<boolean> {
    const snapshot = clone(layout.value)
    if (JSON.stringify(snapshot) === JSON.stringify(persisted)) return true
    const value: HomeSetting = { layout: snapshot, locked: locked.value }
    try {
      await save('home', value)
      persisted = snapshot
      return true
    } catch (e) {
      log.exception('home.layout.save', e)
      layout.value = clone(persisted)
      return false
    }
  }

  return { cols, layout, locked, gridItems, onGridLayoutUpdated, moveBy, resizeBy, commit, scheduleCommit }
}
