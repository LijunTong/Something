// 桌面挂件：把首页卡片「复制」成一个独立的透明浮窗，浮在桌面上常驻。
//
// 设计要点：
// 1. 一张卡最多一个挂件，id 固定为 w-<card>，省掉「同一卡片钉两份」的歧义。
// 2. 几何（x/y/w/h）与置顶状态存在 app_setting.widgets.items；渲染层可以读，
//    但**不能整段写**——settings.set 是按 section 浅合并，多个窗口各写一次数组
//    会互相覆盖，所以所有落库都收敛到这里，统一 read-modify-write。
// 3. 透明窗口在 Windows 上不适合用 -webkit-app-region: drag（会拖影），
//    拖动/缩放由渲染层自绘把手 + 这里的 setBounds 逐帧改 bounds 完成。
// 4. 挂件与首页是「复制」关系：钉到桌面不改首页的 modules 显隐，首页卡片照常显示。
const { BrowserWindow, screen } = require('electron')
const logger = require('./log/logger.cjs')

const CARD_KEYS = ['weather', 'schedule', 'todo', 'pomodoro', 'feed', 'parcel', 'mail', 'notice']
// 上限压住「每窗一个渲染进程」的内存开销：6 个挂件 ≈ 300~500MB
const MAX_WIDGETS = 6
const DEFAULT_W = 360
const DEFAULT_H = 340
const MIN_W = 260
const MIN_H = 220
const MAX_W = 1600
const MAX_H = 1400
// moved/resize 事件是逐帧来的，等停手再落库
const SAVE_DELAY_MS = 400
// 夹取窗口时至少留在屏幕内的像素，避免「拖出去就再也抓不到」
const KEEP_VISIBLE = 120
// 拖出窗口的判定：光标要越过主窗口边缘这么多像素才算（贴着边抖动不算）
const DRAG_EDGE = 6
// 轮询间隔：40ms 足够跟手，拖一次最多几十次调用
const DRAG_POLL_MS = 40
// 越界要持续这么久才认：贴着窗口边缘拖过一下不算「拖出去」
const OUTSIDE_HOLD_MS = 100
// 渲染层万一没来解除，20 秒后自动停
const DRAG_WATCH_MS = 20000

function badRequest(message) {
  const err = new Error(message)
  err.code = 'WIDGET_INVALID'
  return err
}

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function intOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

/**
 * @param {{
 *   settings: { get: (key: string) => any, set: (dto: object) => any },
 *   getMainWindow: () => Electron.BrowserWindow | null,
 *   preload: string,
 *   distIndex: string,
 *   devUrl?: string,
 *   headless?: boolean,
 *   notify?: () => void
 * }} deps
 */
function createWidgetService(deps) {
  const settings = deps.settings
  const getMainWindow = deps.getMainWindow || function () { return null }
  const headless = !!deps.headless
  const devUrl = deps.devUrl || ''
  const distIndex = deps.distIndex
  const preload = deps.preload
  const notify = typeof deps.notify === 'function' ? deps.notify : function () {}

  /** id -> { id, win, saveTimer, silentClose } */
  const live = new Map()
  // closeAll 期间窗口的 closed 回调不要把配置一起清掉
  let closingAll = false
  // 「拖出窗口」监视器：渲染层按下卡片标题时开启，光标真正越界后通知它
  let dragTimer = null

  function isCard(card) {
    return CARD_KEYS.indexOf(String(card || '')) >= 0
  }

  /** 把库里的数组洗干净：未知卡片、重复项、越界尺寸都丢掉/夹住 */
  function normalizeItems(raw) {
    const out = []
    const seen = new Set()
    const list = Array.isArray(raw) ? raw : []
    for (const it of list) {
      if (!it || typeof it !== 'object') continue
      const card = String(it.card || '')
      if (!isCard(card)) continue
      const id = 'w-' + card
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        id: id,
        card: card,
        x: intOr(it.x, 0),
        y: intOr(it.y, 0),
        w: clampNum(intOr(it.w, DEFAULT_W), MIN_W, MAX_W),
        h: clampNum(intOr(it.h, DEFAULT_H), MIN_H, MAX_H),
        alwaysOnTop: it.alwaysOnTop === true,
        locked: it.locked === true
      })
      if (out.length >= MAX_WIDGETS) break
    }
    return out
  }

  function readItems() {
    let cfg = null
    try {
      cfg = settings.get('widgets')
    } catch (e) {
      cfg = null
    }
    return normalizeItems(cfg && cfg.items)
  }

  function writeItems(items) {
    try {
      settings.set({ widgets: { items: items } })
    } catch (e) {
      logger.warn('widget', 'persist_failed', { message: e && e.message })
      return false
    }
    notify()
    return true
  }

  /** 选离窗口中心最近的显示器工作区 */
  function pickArea(cx, cy) {
    let primary = null
    try {
      primary = screen.getPrimaryDisplay().workArea
    } catch (e) {
      primary = { x: 0, y: 0, width: 1280, height: 800 }
    }
    let best = primary
    let bestDist = Infinity
    let displays = []
    try {
      displays = screen.getAllDisplays()
    } catch (e) {
      displays = []
    }
    for (const d of displays) {
      const a = d.workArea
      const dx = Math.max(a.x - cx, 0, cx - (a.x + a.width))
      const dy = Math.max(a.y - cy, 0, cy - (a.y + a.height))
      const dist = dx * dx + dy * dy
      if (dist === 0) return a
      if (dist < bestDist) {
        bestDist = dist
        best = a
      }
    }
    return best
  }

  /** 把几何夹进显示器工作区（拔掉副屏、改缩放后重新夹一次） */
  function fitToDisplay(item) {
    const area = pickArea(item.x + Math.round(item.w / 2), item.y + Math.round(item.h / 2))
    const w = Math.round(clampNum(item.w, MIN_W, Math.min(MAX_W, area.width)))
    const h = Math.round(clampNum(item.h, MIN_H, Math.min(MAX_H, area.height)))
    const minX = area.x - w + KEEP_VISIBLE
    const maxX = area.x + area.width - KEEP_VISIBLE
    const minY = area.y
    const maxY = area.y + area.height - 64
    return {
      x: Math.round(clampNum(item.x, Math.min(minX, maxX), maxX)),
      y: Math.round(clampNum(item.y, Math.min(minY, maxY), maxY)),
      w: w,
      h: h
    }
  }

  function defaultPosition(index) {
    let area = null
    try {
      area = screen.getPrimaryDisplay().workArea
    } catch (e) {
      area = { x: 0, y: 0, width: 1440, height: 900 }
    }
    return {
      x: area.x + area.width - DEFAULT_W - 48 - (index % 3) * 28,
      y: area.y + 72 + (index % 4) * 28
    }
  }

  function scheduleSave(id) {
    const st = live.get(id)
    if (!st) return
    if (st.saveTimer) clearTimeout(st.saveTimer)
    st.saveTimer = setTimeout(function () {
      st.saveTimer = null
      persistBounds(id)
    }, SAVE_DELAY_MS)
  }

  function persistBounds(id) {
    const st = live.get(id)
    if (!st || st.win.isDestroyed()) return
    let b = null
    try {
      b = st.win.getBounds()
    } catch (e) {
      return
    }
    const items = readItems()
    const it = items.find(function (i) { return i.id === id })
    if (!it) return
    if (it.x === b.x && it.y === b.y && it.w === b.width && it.h === b.height) return
    it.x = b.x
    it.y = b.y
    it.w = b.width
    it.h = b.height
    writeItems(items)
  }

  function createWindowFor(item) {
    const geo = fitToDisplay(item)
    const win = new BrowserWindow({
      x: geo.x,
      y: geo.y,
      width: geo.w,
      height: geo.h,
      title: '桌面挂件',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      thickFrame: false,
      show: false,
      alwaysOnTop: item.alwaysOnTop === true,
      webPreferences: {
        preload: preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        spellcheck: false,
        // 番茄钟倒计时、快递/邮件轮询在挂件里也要走真实节奏，不能被后台降频
        backgroundThrottling: false
      }
    })
    if (item.alwaysOnTop) win.setAlwaysOnTop(true, 'floating')
    const state = { id: item.id, win: win, saveTimer: null, silentClose: false }
    live.set(item.id, state)

    win.once('ready-to-show', function () {
      if (!headless && !win.isDestroyed()) win.showInactive()
    })
    win.on('moved', function () { scheduleSave(item.id) })
    win.on('resize', function () { scheduleSave(item.id) })
    win.on('closed', function () {
      const st = live.get(item.id)
      if (st && st.saveTimer) clearTimeout(st.saveTimer)
      live.delete(item.id)
      if (closingAll || (st && st.silentClose)) return
      // 用户从系统关掉（Alt+F4 / 任务管理器）也要把配置清掉，否则下次启动会复活
      writeItems(readItems().filter(function (i) { return i.id !== item.id }))
    })

    const hash = '/widget/' + item.card + '?id=' + encodeURIComponent(item.id)
    if (devUrl) win.loadURL(devUrl + '#' + hash)
    else win.loadFile(distIndex, { hash: hash })
    return win
  }

  function focus(id) {
    const st = live.get(id)
    if (!st || st.win.isDestroyed()) return false
    if (!headless) {
      if (st.win.isMinimized()) st.win.restore()
      st.win.show()
    }
    st.win.focus()
    return true
  }

  function list() {
    return { items: readItems(), max: MAX_WIDGETS, live: live.size }
  }

  function create(payload) {
    const card = String((payload && payload.card) || '')
    if (!isCard(card)) throw badRequest('未知卡片：' + card)
    const existing = readItems().find(function (i) { return i.card === card })
    if (existing) {
      focus(existing.id)
      return { id: existing.id, created: false, reason: 'exists' }
    }
    if (live.size >= MAX_WIDGETS) {
      throw badRequest('最多同时钉 ' + MAX_WIDGETS + ' 张卡片到桌面，先收回一张再试')
    }
    const seed = defaultPosition(live.size)
    const draft = {
      id: 'w-' + card,
      card: card,
      x: intOr(payload && payload.x, seed.x),
      y: intOr(payload && payload.y, seed.y),
      w: DEFAULT_W,
      h: DEFAULT_H,
      alwaysOnTop: (payload && payload.alwaysOnTop) === true,
      locked: false
    }
    const geo = fitToDisplay(draft)
    const item = {
      id: draft.id,
      card: card,
      x: geo.x,
      y: geo.y,
      w: geo.w,
      h: geo.h,
      alwaysOnTop: draft.alwaysOnTop,
      locked: false
    }
    if (!live.has(item.id)) createWindowFor(item)
    const items = readItems()
    items.push(item)
    writeItems(items)
    logger.info('widget', 'created', { id: item.id, card: card })
    return { id: item.id, created: true, reason: 'ok' }
  }

  /**
   * 首页松手时调用：由主进程判断光标是否落在主窗口外，避免渲染层坐标系误差。
   * 落在窗口内 → 交给首页布局落库，什么也不做。
   */
  function dropAtCursor(payload) {
    const card = String((payload && payload.card) || '')
    if (!isCard(card)) throw badRequest('未知卡片：' + card)
    let pt = { x: 0, y: 0 }
    try {
      pt = screen.getCursorScreenPoint()
    } catch (e) {
      pt = { x: 0, y: 0 }
    }
    const main = getMainWindow()
    const b = main && !main.isDestroyed() ? main.getBounds() : null
    const inside = !!b && pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height
    if (inside) return { created: false, reason: 'inside' }
    const existing = readItems().find(function (i) { return i.card === card })
    if (existing) {
      focus(existing.id)
      return { id: existing.id, created: false, reason: 'exists' }
    }
    const r = create({ card: card, x: pt.x - 40, y: pt.y - 24 })
    return { id: r.id, created: r.created, reason: r.reason }
  }

  function remove(payload) {
    const id = String((payload && payload.id) || '')
    const st = live.get(id)
    if (st && !st.win.isDestroyed()) {
      st.silentClose = false
      st.win.destroy()
      return true
    }
    writeItems(readItems().filter(function (i) { return i.id !== id }))
    return true
  }

  /** 用户主动「全部收回」：逐个走 remove，让 UI 状态与配置一致 */
  function removeAll() {
    const ids = Array.from(live.keys())
    for (const id of ids) {
      try {
        remove({ id: id })
      } catch (e) {
        logger.warn('widget', 'remove_failed', { id: id, message: e && e.message })
      }
    }
    writeItems([])
    return true
  }

  /** 应用退出前收尾：只关窗，保留配置（下次启动还要恢复） */
  function closeAll() {
    disarmDrag()
    closingAll = true
    for (const st of live.values()) {
      try {
        if (st.saveTimer) {
          clearTimeout(st.saveTimer)
          st.saveTimer = null
        }
        if (!st.win.isDestroyed()) {
          persistBounds(st.id)
          st.silentClose = true
          st.win.destroy()
        }
      } catch (e) {
        logger.warn('widget', 'close_all_failed', { id: st.id, message: e && e.message })
      }
    }
    live.clear()
    closingAll = false
  }

  function patch(payload) {
    const id = String((payload && payload.id) || '')
    const p = (payload && payload.patch) || {}
    const items = readItems()
    const it = items.find(function (i) { return i.id === id })
    if (!it) throw badRequest('挂件不存在：' + id)
    if (typeof p.alwaysOnTop === 'boolean') it.alwaysOnTop = p.alwaysOnTop
    if (typeof p.locked === 'boolean') it.locked = p.locked
    const st = live.get(id)
    if (st && !st.win.isDestroyed() && typeof p.alwaysOnTop === 'boolean') {
      st.win.setAlwaysOnTop(it.alwaysOnTop, 'floating')
    }
    writeItems(items)
    return it
  }

  /**
   * 开启「拖出窗口」监视。
   *
   * 为什么不让渲染层自己判定：窗口外的 pointermove/pointerup 根本到不了页面（没有 pointer capture），
   * 光标一越界 DOM 事件就断了。所以由主进程按 40ms 轮询真实光标（screen.getCursorScreenPoint），
   * 真正越界后回推一次 widget:dragOut，渲染层收尾并创建挂件。
   */
  function armDrag(payload) {
    disarmDrag()
    const card = String((payload && payload.card) || '')
    if (!isCard(card)) return false
    const started = Date.now()
    let outsideAt = 0
    dragTimer = setInterval(function () {
      const main = getMainWindow()
      if (!main || main.isDestroyed()) { disarmDrag(); return }
      // 超长挂起兜底：渲染层没来 disarm 也不会永远轮询
      if (Date.now() - started > DRAG_WATCH_MS) { disarmDrag(); return }
      let pt = null
      try {
        pt = screen.getCursorScreenPoint()
      } catch (e) {
        disarmDrag()
        return
      }
      const b = main.getBounds()
      const outside =
        pt.x < b.x - DRAG_EDGE || pt.x > b.x + b.width + DRAG_EDGE ||
        pt.y < b.y - DRAG_EDGE || pt.y > b.y + b.height + DRAG_EDGE
      if (!outside) { outsideAt = 0; return }
      if (!outsideAt) { outsideAt = Date.now(); return }
      if (Date.now() - outsideAt < OUTSIDE_HOLD_MS) return
      disarmDrag()
      // 再确认一次没被钉过：调用方按返回值给提示
      main.webContents.send('widget:dragOut', { card: card })
    }, DRAG_POLL_MS)
    return true
  }

  function disarmDrag() {
    if (!dragTimer) return false
    clearInterval(dragTimer)
    dragTimer = null
    return true
  }

  /**
   * 拖动只改位置，缩放要同时改位置（从左边/上边拉时左上角也在动），
   * 所以缩放统一走 setBounds，避免两次 IPC 之间出现中间态。
   */
  function setBounds(payload) {
    const st = live.get(String((payload && payload.id) || ''))
    if (!st || st.win.isDestroyed()) return false
    st.win.setBounds({
      x: Math.round(payload.x),
      y: Math.round(payload.y),
      width: clampNum(Math.round(payload.w), MIN_W, MAX_W),
      height: clampNum(Math.round(payload.h), MIN_H, MAX_H)
    })
    return true
  }

  function bounds(payload) {
    const st = live.get(String((payload && payload.id) || ''))
    if (!st || st.win.isDestroyed()) return null
    return st.win.getBounds()
  }

  function showAll() {
    for (const st of live.values()) {
      if (!st.win.isDestroyed() && !headless) st.win.showInactive()
    }
    return live.size
  }

  function hideAll() {
    for (const st of live.values()) {
      if (!st.win.isDestroyed()) st.win.hide()
    }
    return live.size
  }

  /** 启动时恢复上次钉在桌面的挂件；越界坐标顺手夹回来 */
  function restoreAll() {
    const items = readItems()
    if (!items.length) return 0
    const fixed = items.map(function (it) {
      return Object.assign({}, it, fitToDisplay(it))
    })
    if (JSON.stringify(fixed) !== JSON.stringify(items)) writeItems(fixed)
    for (const it of fixed) {
      if (!live.has(it.id)) {
        try {
          createWindowFor(it)
        } catch (e) {
          logger.warn('widget', 'restore_failed', { id: it.id, message: e && e.message })
        }
      }
    }
    return fixed.length
  }

  /** 显示器拔插/缩放变化后重新夹一遍，并把活着的窗口挪回去 */
  function reclampAll() {
    const items = readItems()
    if (!items.length) return 0
    const fixed = items.map(function (it) {
      return Object.assign({}, it, fitToDisplay(it))
    })
    if (JSON.stringify(fixed) === JSON.stringify(items)) return 0
    for (const it of fixed) {
      const st = live.get(it.id)
      if (st && !st.win.isDestroyed()) {
        try {
          st.win.setBounds({ x: it.x, y: it.y, width: it.w, height: it.h })
        } catch (e) {
          logger.warn('widget', 'reclamp_failed', { id: it.id, message: e && e.message })
        }
      }
    }
    writeItems(fixed)
    return fixed.length
  }

  function count() {
    return live.size
  }

  return {
    list: list,
    create: create,
    dropAtCursor: dropAtCursor,
    remove: remove,
    removeAll: removeAll,
    closeAll: closeAll,
    patch: patch,
    armDrag: armDrag,
    disarmDrag: disarmDrag,
    setBounds: setBounds,
    bounds: bounds,
    focus: focus,
    showAll: showAll,
    hideAll: hideAll,
    restoreAll: restoreAll,
    reclampAll: reclampAll,
    count: count
  }
}

module.exports = {
  createWidgetService: createWidgetService,
  CARD_KEYS: CARD_KEYS,
  MAX_WIDGETS: MAX_WIDGETS,
  WIDGET_MIN_W: MIN_W,
  WIDGET_MIN_H: MIN_H,
  WIDGET_MAX_W: MAX_W,
  WIDGET_MAX_H: MAX_H
}
