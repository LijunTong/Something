// Electron 主进程：窗口、数据库生命周期、IPC 注册。
const { app, BrowserWindow, shell, dialog, Tray, Menu, nativeImage, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { z } = require('zod')

// 最早的启动标记：写入 boot.txt，用于区分「主进程没加载」与「加载后崩溃」。
// 若某次启动失败但 boot.txt 没有新行，说明崩在 Chromium 初始化阶段（GPU/沙箱）。
// 注意：必须等数据目录解析完再写，否则未打包时也会在 %APPDATA%\<name> 下建出目录。
const conn = require('./db/conn.cjs')
const { pickDataDir, copyLegacyDb } = require('./db/location.cjs')
const { seed } = require('./db/seed.cjs')
const { createRegistry } = require('./ipc/registry.cjs')
const todoSvc = require('./services/todo.cjs')
const settingsSvc = require('./services/settings.cjs')
const scheduleSvc = require('./services/schedule.cjs')
const pomodoroSvc = require('./services/pomodoro.cjs')
const logger = require('./log/logger.cjs')
const weatherSvc = require('./services/weather.cjs')
const feedSvc = require('./services/feed.cjs')
const parcelSvc = require('./services/parcel.cjs')
const mailSvc = require('./services/mail.cjs')
const notificationSvc = require('./services/notification.cjs')
const notifySvc = require('./services/notify.cjs')
const searchSvc = require('./services/search.cjs')
const updateSvc = require('./services/update.cjs')
const projectSvc = require('./services/project.cjs')
const mcpServer = require('./mcp/server.cjs')
const mcpTools = require('./mcp/tools.cjs')

// 开发/生产方式只由 VITE_URL 决定：只有 scripts/dev.cjs 会注入它（同时拉起 Vite）。
// 未注入时即使未打包也只加载 dist，避免 npm start 去连一个没启动的 5173。
const DEV_URL = process.env.VITE_URL || ''
const isDev = !!DEV_URL
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html')
// 无头自测：TK_HEADLESS=1 时窗口只创建不显示，测试脚本经由 --remote-debugging-port 走 CDP 驱动。
// 这样跑断言不会打断用户当前桌面，也不用另装 playwright（见 AGENTS.md 第六节）。
const HEADLESS = process.env.TK_HEADLESS === '1'
let win = null
let registry = null

// 数据目录解析（必须在 app ready 之前完成）：
// 默认用 userData；若它不可写（受限沙箱 / 只读配置目录 / 安全软件拦截），
// 回退到应用目录下的 .data，否则 SQLite 打开后一写就报
// "attempt to write a readonly database"，日志也会静默丢失。
// 仍可用 TK_DATA_DIR 显式指定（此时不做回退，路径不可写就按原样报错）。
// 用 appData + 应用名推导，不直接调 getPath('userData')：后者会在磁盘上把目录建出来，
// 未打包时就会凭空多出一个空的 %APPDATA%\<name>（打包后它就是真正的数据目录）。
const defaultDataDir = path.join(app.getPath('appData'), app.getName())
// 开发/自测与安装版必须用两套互不相干的数据目录：两者 package.json 的 name 相同，
// 只要都走 userData 就会落到同一个 %APPDATA%\<name>，安装包于是读到开发时的数据。
// 因此未打包时固定用仓库内 .data（缓存、日志也一起走这里），只有打包后的应用才读写 userData。
const IS_PACKAGED = app.isPackaged
const DEV_DATA_DIR = path.join(app.getAppPath(), '.data')
const PORTABLE_DATA_DIR = path.join(path.dirname(app.getPath('exe')), 'data')
const dataDir = IS_PACKAGED
  ? pickDataDir({
      override: process.env.TK_DATA_DIR,
      defaultDir: defaultDataDir,
      // 已经回退过一次的目录里若已有库，就固定用它，避免两次启动落到不同位置
      stickyDir: PORTABLE_DATA_DIR,
      candidates: [PORTABLE_DATA_DIR, path.join(app.getPath('temp'), 'something')]
    })
  : pickDataDir({
      override: process.env.TK_DATA_DIR,
      defaultDir: DEV_DATA_DIR,
      candidates: [path.join(app.getPath('temp'), 'something-dev')]
    })
if (path.resolve(dataDir.dir) !== path.resolve(defaultDataDir)) {
  // setPath 要求目录已存在；递归建目录失败时保持默认目录，避免启动即崩。
  try {
    fs.mkdirSync(dataDir.dir, { recursive: true })
    app.setPath('userData', dataDir.dir)
  } catch (e) {
    console.error('[db] 无法切换数据目录 ' + dataDir.dir + ': ' + e.message)
  }
}

try {
  const dirBoot = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dirBoot, { recursive: true })
  fs.appendFileSync(path.join(dirBoot, 'boot.txt'), new Date().toISOString() + ' main.js loaded pid=' + process.pid + '\n')
} catch (e) {}

// 不做「旧版本目录（efficiency-toolkit）整库迁移」：
// 那个目录里只有早期开发/测试留下的数据，把它复制进安装版既没有价值，又会在用户
// 主动删库后被反复搬回来（表现为「数据删了，重开又是之前的数据」）。
// 安装版永远从空库开始，只写 seed 的结构性默认值（收件箱、默认日历、番茄状态）。
// 需要旧数据就自己导出/导入，不靠启动时静默复制。

// 部分机器的 GPU 进程无法启动（日志表现为 "GPU process launch failed: error_code=18"
// 连续出现后 "FATAL: GPU process isn't usable"，进程随之退出）。
// 本应用是工具类界面，不依赖硬件加速，因此默认关闭 GPU 渲染；
// 需要硬件加速时设置 TK_ENABLE_GPU=1 即可恢复默认行为。
if (process.env.TK_ENABLE_GPU !== '1') {
  // 本机 GPU 子进程无法启动（error_code=18），Chromium 连续重试后
  // 在 gpu_data_manager_impl_private.cc 里 FATAL 退出。
  //
  // 关键：只加 disableHardwareAcceleration() 不够 —— Chromium 仍会尝试
  // 派生独立的 GPU 子进程，子进程起不来就 FATAL。
  // in-process-gpu 让 GPU 在当前进程内运行，不再派生子进程，从根上绕开这条路径。
  //
  // 注意：不要加 use-gl=swiftshader / use-angle=swiftshader，
  // Electron 28 只接受 egl-angle，传 swiftshader 会报
  // "Requested GL implementation (gl=none,angle=none) not found"。
  // 回退到已验证可启动的组合（2026-11-20 00:53 曾成功弹窗）：
  // 只用 disableHardwareAcceleration + in-process-gpu，
  // 不要指定 use-gl / use-angle —— Electron 28 会解析失败并直接 FATAL。
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('in-process-gpu')
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  // 关闭与本地开发无关的后台联网探测（会打印 SSL handshake failed）。
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('disable-domain-reliability')
}

// 应急：任何额外的 Chromium 开关都可经 TK_SWITCHES 传入，逗号分隔。
// 例：TK_SWITCHES=disable-features=Vulkan,enable-unsafe-swiftshader
if (process.env.TK_SWITCHES) {
  for (const s of process.env.TK_SWITCHES.split(',')) {
    const v = s.trim()
    if (!v) continue
    const i = v.indexOf('=')
    if (i > 0) app.commandLine.appendSwitch(v.slice(0, i), v.slice(i + 1))
    else app.commandLine.appendSwitch(v)
  }
}

// 受限容器或部分 Windows 会话里 renderer 沙箱会导致进程直接崩溃，
// 设置 TK_NO_SANDBOX=1 可规避（不影响主进程仍是唯一能访问 SQLite 的地方）。
// 注意：如果崩溃发生在本文件执行之前（Chromium 沙箱初始化失败，退出码
// 0x80000003 / 2147483651），这里 appendSwitch 已经来不及生效，
// 必须在命令行上带 --no-sandbox —— scripts/dev.cjs 与 scripts/start.cjs
// 已自动探测该崩溃并重试。
if (process.env.TK_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox')
}

/* ---------- 单例启动：第二个实例只唤起已存在的窗口 ---------- */
const singleLock = app.requestSingleInstanceLock()
if (!singleLock) {
  app.quit()
}
// 与 electron-builder 的 appId 保持一致：打包后快捷方式带的 AUMID 会让托盘/通知归属到本应用
if (process.platform === 'win32') app.setAppUserModelId('com.something.jijianshi')
let quitting = false
let tray = null
let trayHintShown = false
let suppressMinimizeHide = false
/**
 * 打包后资源在 app.asar 里，nativeImage / Tray 读不到 asar 内的图片，
 * 所以 assets 通过 asarUnpack 外置到 app.asar.unpacked，这里按同样规则换算路径。
 */
function assetPath(name) {
  const p = path.join(__dirname, 'assets', name)
  return app.isPackaged ? p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : p
}
const ICON_PATH = assetPath('icon.png')
// Windows 托盘优先用 ICO（多尺寸），PNG 作为回退
const TRAY_ICON_PATH = process.platform === 'win32' ? assetPath('tray-16.ico') : assetPath('tray.png')

/**
 * 托盘菜单项图标（16pt，由 Icons.vue 的线性图标渲染而来）。
 * 菜单图标在部分平台/主题下不渲染，取不到就静默跳过，不影响菜单本身。
 */
const menuIconCache = new Map()
function menuIcon(name) {
  if (menuIconCache.has(name)) return menuIconCache.get(name)
  let img = null
  try {
    let loaded = nativeImage.createFromPath(assetPath('menu-' + name + '.png'))
    if (loaded && !loaded.isEmpty()) {
      // 菜单小图标固定 16pt，资源比这个大就压回去，避免图标顶到菜单行高
      if (loaded.getSize().width > 16) loaded = loaded.resize({ width: 16, height: 16, quality: 'best' })
      img = loaded
    }
  } catch (e) {
    img = null
  }
  menuIconCache.set(name, img)
  return img
}

/** 读取窗口行为设置（关闭/最小化到托盘、开机启动） */
function windowPrefs() {
  const cfg = settingsSvc.get('window')
  return Object.assign({ closeToTray: true, minimizeToTray: false, launchAtLogin: false }, cfg || {})
}

function showMainWindow() {
  if (!win) { createWindow(); return }
  // 无头模式不接受任何「显示窗口」的请求（托盘双击、通知跳转、单实例激活都会走到这里）
  if (HEADLESS) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 首次收进托盘时提示一次：Windows 新图标默认会折叠到任务栏右下角的 ^ 里 */
function hintTrayOnce(force) {
  if (!force && trayHintShown) return
  if (!tray || tray.isDestroyed()) return
  trayHintShown = true
  if (process.platform !== 'win32') return
  try {
    tray.displayBalloon({
      title: '几件事仍在后台运行',
      content: '窗口已收进系统托盘。如果任务栏右下角没看到图标，点一下 ^ 展开隐藏图标，双击图标即可恢复窗口。',
      iconType: 'info'
    })
  } catch (e) {
    logger.warn('main', 'tray_balloon_failed', { message: e && e.message })
  }
}

/** 开机启动：系统登录项是唯一状态源，菜单勾选态以它为准 */
function loginAtStartup() {
  try { return !!app.getLoginItemSettings().openAtLogin } catch (e) { return !!windowPrefs().launchAtLogin }
}

/** 托盘里改开机启动：写系统登录项 + 落设置，再广播给设置页保持两处一致 */
function toggleLoginAtStartup(enabled) {
  const on = !!enabled
  try {
    const opts = { openAtLogin: on }
    // 开发态没有安装包，登录项指向当前 Electron 可执行文件 + 应用目录
    if (!app.isPackaged) { opts.path = process.execPath; opts.args = [app.getAppPath()] }
    app.setLoginItemSettings(opts)
  } catch (e) {
    logger.warn('system', 'launch_at_login_toggle_failed', { message: e && e.message })
  }
  settingsSvc.set({ window: Object.assign(windowPrefs(), { launchAtLogin: on }) })
  if (registry) {
    BrowserWindow.getAllWindows().forEach(function (w) {
      if (!w.isDestroyed()) registry.broadcast(w.webContents, 'settings', 'set')
    })
  }
  logger.info('system', 'launch_at_login_toggled', { enabled: on })
}

/**
 * 托盘菜单：窗口显示/隐藏交给托盘图标单击切换，菜单里只放开机启动开关。
 */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '开机启动', type: 'checkbox', checked: loginAtStartup(), click: function (item) { toggleLoginAtStartup(item.checked); updateTrayMenu() } },
    { type: 'separator' },
    { label: '仪表盘', icon: menuIcon('home'), click: function () { showMainWindow(); win && win.webContents.send('app:navigate', '/') } },
    { label: '待办', icon: menuIcon('todo'), click: function () { showMainWindow(); win && win.webContents.send('app:navigate', '/todo') } },
    { label: '天气', icon: menuIcon('weather'), click: function () { showMainWindow(); win && win.webContents.send('app:navigate', '/weather') } },
    { label: '设置', icon: menuIcon('settings'), click: function () { showMainWindow(); win && win.webContents.send('app:navigate', '/settings') } },
    { type: 'separator' },
    { label: '退出', icon: menuIcon('quit'), click: function () { quitting = true; app.quit() } }
  ])
}

/** 窗口可见性变化后重建托盘菜单，保证勾选态同步 */
function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  tray.setContextMenu(buildTrayMenu())
}

function createTray() {
  if (tray && !tray.isDestroyed()) return
  // 32px 图标在高 DPI 下更清晰；Windows 会自动缩放到托盘尺寸

  // Windows 托盘优先用 ICO 文件（官方文档：图标格式按平台区分），data URL 仅作兜底
  let image = nativeImage.createFromPath(TRAY_ICON_PATH)
  if (image.isEmpty()) image = nativeImage.createFromPath(ICON_PATH)
  if (image.isEmpty()) image = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAADLUlEQVR4nE2TzYscRRjGn/et6unu2Z6dmZ3V0Wwwa4RkJWpEo+5hIehNwYiHCYq5qugfIAQSljnE9SKecpBcxOPkIFHEEASREDDZxBgiISTZVScf635kdsjOV3dX1Ru6g2Ad6gOqnnrq+b1F+H+TeQY1XTYlAFPt0xPxYPxZa2UfgFcB7GKGE+Kf2YwW1p97vZftAwS0H/PqV2oanL9Ti6L1TwjuDVgzwyRPclgAw8EaQATwSj5cZ/OsYvsWZYeR9QCeX27t3rKVH/1q8ZlCvInAbsF3PfgcW80GqSvQyrCOe8O69WoVz3a7zdzBO5tfVZTYBWPlfVJUVnE/VQQWEBOY8jeBAThocrjVm3a30j3Qae9ParS/DBMvPlN8ojzn1gbwnHLCxAOX5LZSMVDE+eiRByMGIUEWt2apOwhv60Qnn4bVaK5zbyN5XJW818JdXIDG5eQvpEQwLsGbxZcQkAcFxu/x37iUXEXN76LTLxmtmBq94cDt0I/pQ6X9FFEAgcNN8y8GcJj2apj1ZrBuh1AIMB6UcTG5IgVtCeQe6NTZ+pgL+YvqIal6pYwIfhtdx810BXVvEooIsQM6qUFAgFOPEIMZEL6vSYgcHM6OrqFmxqFJoW02MJIEPnm4ka7giroBZoUB3ce1pA0QSSbjiDZ0JpSIQWt4HmUdQUTy9c7Cdjzl1bFCGqfiS5CcN2BF4ENDHlXQms6S1mD0bR99N4SFxU5dhxZGO11Fx3Qx58+goqJc5MJoCcuykYmJA69pBsUJrEypKorsY9P18Hn1Axx/8BOu2rvYpqqY9XdjSk9gJCmyq5fNEokIpTZYzArlAvmKCqTt0epBHK99hG96v+D08DLGKESZx7A3mMaq7aLMRbyod1gbFdkb9U7Z7/ecoXdXF/Yy64tbNNL75GkzqUr8w3ARFY4wxkWwCA4UX8ndZXz/wD/63PC62c5u+uvJI3fzKA7cOfaeXwpOjNhGJkkRcYCMjBPJwxpInIfLWmXZJIUBPvxu2+FvG9JS1Gg11MmDJ+3bS8deCCbCj8W4l41J/f9+OIGsIjKkOWWtl6SfnmhNfXZuXua5SU33EKj/e3aXpDZnAAAAAElFTkSuQmCC')
  if (image.isEmpty()) {
    logger.warn('main', 'tray_icon_missing', { icon: ICON_PATH })
    return
  }
  // 官方文档：macOS 菜单栏图标建议用 template image，系统按深/浅色模式自动反色
  if (process.platform === 'darwin') image.setTemplateImage(true)
  // 直接交原始位图给系统缩放：手动 resize 后部分 Windows 环境拿不到托盘图标句柄
  tray = new Tray(image)
  // 官方文档：macOS 开启后单双击合并为 click，避免窗口 toggle 被双击事件干扰
  if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true)
  tray.setToolTip('几件事 · 单击显示/隐藏窗口，右键更多')
  updateTrayMenu()
  logger.info('main', 'tray_ready', { icon: ICON_PATH })
  // bounds 为空说明 Windows 把图标收进了 ^ 展开区：主动提示一次，避免用户以为没有托盘
  setTimeout(function () {
    try {
      const b = tray && !tray.isDestroyed() ? tray.getBounds() : null
      if (!b || !b.width) hintTrayOnce(true)
    } catch (e) { /* 忽略探测失败 */ }
  }, 1500)
  tray.on('click', function () {
    if (win && win.isVisible()) win.hide()
    else showMainWindow()
  })
  tray.on('double-click', function () { showMainWindow() })
}


function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: '几件事',
    // 自绘标题栏：系统边框与标题都关掉，拖拽区与窗口按钮由渲染层负责
    frame: false,
    titleBarStyle: 'hidden',
    icon: ICON_PATH,
    backgroundColor: '#f5f7fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 开发期加载本地 Vite 服务，关闭不需要的能力，减少无谓网络探测
      webSecurity: true,
      spellcheck: false,
      // 隐藏窗口默认会被降频（定时器/rAF 变慢），自测时的计时逻辑会失真
      backgroundThrottling: !HEADLESS
    }
  })
  win.once('ready-to-show', function () { if (!HEADLESS) win.show() })
  if (isDev) {
    win.loadURL(DEV_URL)
  } else if (fs.existsSync(DIST_INDEX)) {
    win.loadFile(DIST_INDEX)
  } else {
    // 产物缺失时不显示 ERR_FILE_NOT_FOUND 白屏，直接给一条可执行的提示。
    const hint = '<!doctype html><meta charset="utf-8"><body style="font:14px/1.7 system-ui;padding:48px;color:#0f172a">'
      + '<h2 style="margin:0 0 12px;font-size:18px">尚未构建前端产物</h2>'
      + '<p style="margin:0 0 8px">找不到 dist/index.html。开发模式请运行 <code>npm run dev</code>，'
      + '普通运行请先执行 <code>npm run build</code> 再 <code>npm start</code>。</p>'
      + '<p style="color:#64748b">预期路径：' + DIST_INDEX.replace(/</g, '&lt;') + '</p></body>'
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(hint))
  }
  win.webContents.setWindowOpenHandler(function (d) {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })
  win.on('closed', function () { win = null })
  // 关闭 / 最小化到托盘：按设置拦住默认行为，只隐藏窗口，保留托盘与应用进程
  win.on('close', function (e) {
    if (quitting) return
    if (windowPrefs().closeToTray) {
      e.preventDefault()
      // 托盘图标真实可见（bounds 非空）才隐藏到托盘；否则退回最小化，
      // 避免 Windows 把新图标折叠进 ^ 时用户找不到窗口、以为应用退出了
      let trayVisible = false
      try { trayVisible = !!tray && !tray.isDestroyed() && tray.getBounds().width > 0 } catch (err) { trayVisible = false }
      if (trayVisible) {
        win.hide()
      } else {
        suppressMinimizeHide = true
        win.minimize()
        logger.warn('main', 'tray_not_visible_minimize_instead')
      }
      hintTrayOnce()
    }
  })
  win.on('minimize', function () {
    if (suppressMinimizeHide) { suppressMinimizeHide = false; return }
    if (windowPrefs().minimizeToTray) { win.hide(); hintTrayOnce() }
  })
  // 托盘菜单「显示主窗口」勾选态跟随窗口可见性（官方示例做法）
  win.on('show', function () { updateTrayMenu() })
  win.on('hide', function () { updateTrayMenu() })
  win.on('maximize', function () { win && win.webContents.send('window:maximized', true) })
  win.on('unmaximize', function () { win && win.webContents.send('window:maximized', false) })
}

// MCP：应用内本地 HTTP 服务。只在设置开启时监听 127.0.0.1，端口/令牌改动后由 syncMcp 重载。
let mcpReady = false

// 默认端口按运行方式分开：开发版与安装版可能同时开着，同端口会让后启动的一方 START_FAILED。
// 优先级：TK_MCP_PORT（环境变量，适合多实例/自测） > 设置里保存的端口 > 按环境默认。
const MCP_DEFAULT_PORT = IS_PACKAGED ? 3928 : 3927

function mcpPort() {
  const raw = String(process.env.TK_MCP_PORT || '').trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) return { port: n, source: 'env' }
    logger.warn('mcp', 'invalid_env_port', { value: raw })
  }
  const cfg = settingsSvc.all().mcp || {}
  if (Number.isInteger(cfg.port) && cfg.port >= 1024 && cfg.port <= 65535) return { port: cfg.port, source: 'setting' }
  return { port: MCP_DEFAULT_PORT, source: 'default' }
}

function mcpState() {
  const st = mcpServer.status()
  const cfg = settingsSvc.all().mcp || { enabled: false, port: null }
  const resolved = mcpPort()
  return {
    enabled: !!cfg.enabled,
    port: st.port || resolved.port,
    configuredPort: Number.isInteger(cfg.port) ? cfg.port : null,
    portSource: resolved.source,
    endpoint: st.running ? st.endpoint : null,
    tokenSet: !!settingsSvc.mcpToken(),
    calls: st.calls,
    lastCallAt: st.lastCallAt,
    lastTool: st.lastTool,
    lastError: st.lastError
  }
}

// 开启 -> 确保令牌并起服务；关闭 -> 停服务。端口被占用时不漂移到别的端口，保留 lastError 给设置页显示。
async function syncMcp() {
  if (!mcpReady) return mcpState()
  const cfg = settingsSvc.all().mcp || {}
  mcpServer.stop()
  if (!cfg.enabled) return mcpState()
  settingsSvc.ensureMcpToken()
  const started = await mcpServer.start(mcpPort().port)
  if (!started.ok) logger.warn('mcp', 'start_failed', { error: started.error })
  return mcpState()
}

function initMcp() {
  mcpReady = true
  mcpServer.init({
    version: app.getVersion(),
    getToken: function () { return settingsSvc.mcpToken() },
    listTools: mcpTools.list,
    callTool: function (name, args) {
      const out = mcpTools.call(name, args)
      // 写入成功后广播 todo 域，待办列表与计划条立即重取（与设置广播同一套 data:changed 约定）
      if (!out.isError) {
        BrowserWindow.getAllWindows().forEach(function (w) {
          if (!w.isDestroyed()) registry.broadcast(w.webContents, 'todo', 'mcp')
        })
      }
      return out
    },
    log: function (level, msg, meta) { logger[level === 'warn' ? 'warn' : 'info']('mcp', msg, meta) }
  })
  return syncMcp()
}

function stopMcp() {
  mcpServer.stop()
}

function registerIpc() {
  registry = createRegistry()
  registry.register('todo', {
    list: todoSvc.list,
    get: todoSvc.get,
    create: todoSvc.create,
    update: todoSvc.update,
    toggle: todoSvc.toggle,
    remove: todoSvc.remove,
    reorder: todoSvc.reorder,
    addSubtask: todoSvc.addSubtask,
    toggleSubtask: todoSvc.toggleSubtask,
    lists: todoSvc.lists,
    createList: todoSvc.createList,
    updateList: todoSvc.updateList,
    removeList: todoSvc.removeList,
    stats: todoSvc.stats
  })
  registry.register('schedule', {
    range: scheduleSvc.range, get: scheduleSvc.get, create: scheduleSvc.create,
    update: scheduleSvc.update, remove: scheduleSvc.remove,
    checkConflict: scheduleSvc.checkConflict,
    calendars: scheduleSvc.calendars, toggleCalendar: scheduleSvc.toggleCalendar,
    createCalendar: scheduleSvc.createCalendar, updateCalendar: scheduleSvc.updateCalendar,
  calendarUsage: scheduleSvc.calendarUsage,
    removeCalendar: scheduleSvc.removeCalendar,
    exportICS: scheduleSvc.exportICS, importICS: scheduleSvc.importICS
  })
  registry.register('pomodoro', {
    state: pomodoroSvc.state, start: pomodoroSvc.start, pause: pomodoroSvc.pause,
    resume: pomodoroSvc.resume, complete: pomodoroSvc.complete,
    abandon: pomodoroSvc.abandon, skipBreak: pomodoroSvc.skipBreak, tick: pomodoroSvc.tick,
    setTask: pomodoroSvc.setTask, config: pomodoroSvc.config, saveConfig: pomodoroSvc.saveConfig,
    stats: pomodoroSvc.stats, weekStats: pomodoroSvc.weekStats, recent: pomodoroSvc.recent
  })
  registry.register('weather', {
    cities: weatherSvc.cities, addCity: weatherSvc.addCity,
    removeCity: weatherSvc.removeCity, setHome: weatherSvc.setHome,
    // 城市搜索：返回 GeoAPI 候选列表，由渲染层让用户选择
    searchCities: { schema: z.object({ keyword: z.string().min(1).max(40) }), handler: weatherSvc.searchCities },
    // 重新经 GeoAPI 定位：补齐/更新城市的 LocationID 与经纬度
    relocate: weatherSvc.relocate,
    fetch: weatherSvc.fetch
  })
  registry.register('feed', {
    groups: feedSvc.groups, addGroup: feedSvc.addGroup,
    // 分类改名 / 删除分类（删除时服务内部把订阅迁到默认分类）
    updateGroup: {
      schema: z.object({ id: z.string().min(1), name: z.string().min(1) }),
      handler: feedSvc.updateGroup
    },
    removeGroup: { schema: z.string().min(1), handler: feedSvc.removeGroup },
    sources: feedSvc.sources, addSource: feedSvc.addSource,
    removeSource: feedSvc.removeSource, toggleSource: feedSvc.toggleSource,
    // 修改订阅源：入参经 zod 校验，只接受可编辑字段
    updateSource: {
      schema: z.object({
        id: z.string().min(1),
        url: z.string().min(1).optional(),
        title: z.string().optional(),
        groupId: z.string().nullable().optional(),
        intervalMin: z.number().int().min(1).max(10080).optional()
      }),
      handler: feedSvc.updateSource
    },
    items: feedSvc.items, markRead: feedSvc.markRead,
    // 列表工具栏的批量操作：ids 至少 1 条，非法入参由 zod 拦下
    markReadMany: {
      schema: z.object({ ids: z.array(z.string().min(1)).min(1) }),
      handler: function (dto) { return feedSvc.markReadMany(dto.ids) }
    },
    removeItems: {
      schema: z.object({ ids: z.array(z.string().min(1)).min(1) }),
      handler: function (dto) { return feedSvc.removeItems(dto.ids) }
    },
    // 单篇详情：registry 把 zod 解析后的对象交给 handler，必须在这里解包
    detail: {
      schema: z.object({ id: z.string().min(1) }),
      handler: function (dto) { return feedSvc.detail(dto.id) }
    },
    toggleStar: feedSvc.toggleStar, toggleLater: feedSvc.toggleLater,
    refresh: feedSvc.refresh, importOPML: feedSvc.importOPML, exportOPML: feedSvc.exportOPML
  })
  registry.register('parcel', {
    list: parcelSvc.list,
    // 新增：可传手选快递公司与手机号后四位，未传则按单号前缀自动识别
    add: {
      schema: z.object({
        numbers: z.array(z.string()).min(1),
        alias: z.string().optional(),
        note: z.string().optional(),
        company: z.string().optional(),
        phoneTail: z.string().optional()
      }),
      handler: function (dto) { const out = parcelSvc.add(dto); broadcastParcel('add'); return out }
    },
    // 刷新：兼容旧调用只传 id 字符串；新版可带手选公司与手机号后四位
    refresh: {
      schema: z.union([
        z.string().min(1),
        z.object({ id: z.string().min(1), company: z.string().optional(), phoneTail: z.string().optional() })
      ]),
      handler: function (dto) { return parcelSvc.refresh(dto).then(function (out) { if (!out.error) broadcastParcel('refresh'); return out }) }
    },
    // 一键刷新：默认只刷未签收的，force 为真时连已签收也重查
    refreshAll: {
      schema: z.object({ force: z.boolean().optional() }).optional(),
      handler: function (dto) {
        return parcelSvc.refreshAll(dto || {}).then(function (out) {
          if (out.added || out.changed) broadcastParcel('refreshAll')
          return out
        })
      }
    },
    // 数据源菜单与凭据状态：只回状态位，不回明文
    providers: function () { return parcelSvc.providers() },
    companies: function () { return parcelSvc.companies() },
    testProvider: {
      schema: z.object({
        provider: z.string().optional(),
        no: z.string().optional(),
        company: z.string().optional(),
        phoneTail: z.string().optional(),
        values: z.record(z.string(), z.string()).optional()
      }),
      handler: parcelSvc.testProvider
    },
    get: { schema: z.string().min(1), handler: parcelSvc.get },
    tracks: parcelSvc.tracks,
    archive: {
      schema: z.union([z.string().min(1), z.object({ id: z.string().min(1) })]),
      handler: function (dto) { const out = parcelSvc.archive(dto); broadcastParcel('archive'); return out }
    },
    togglePrivacy: {
      schema: z.object({ id: z.string().min(1), masked: z.boolean() }),
      handler: function (dto) { const out = parcelSvc.togglePrivacy(dto); broadcastParcel('togglePrivacy'); return out }
    },
    togglePrivacy: parcelSvc.togglePrivacy, toTodoInfo: parcelSvc.toTodoInfo
  })
  registry.register('mail', {
    accounts: mailSvc.accounts, addAccount: mailSvc.addAccount,
    // 账户管理：编辑与删除同样走 zod 入参校验；授权码可不传，表示沿用原值
    updateAccount: {
      schema: z.object({
        id: z.string().min(1),
        alias: z.string().optional(),
        email: z.string().min(1).optional(),
        protocol: z.string().optional(),
        imapHost: z.string().nullable().optional(),
        imapPort: z.number().int().nullable().optional(),
        smtpHost: z.string().nullable().optional(),
        smtpPort: z.number().int().nullable().optional(),
        username: z.string().nullable().optional(),
        secret: z.string().optional(),
        syncDays: z.number().int().min(1).max(3650).optional(),
        enabled: z.boolean().optional()
      }),
      handler: mailSvc.updateAccount
    },
    removeAccount: { schema: z.object({ id: z.string().min(1) }), handler: mailSvc.removeAccount },
    // 明文回显授权码：设置页默认掩码，用户点「显示」时才调
    revealSecret: { schema: z.object({ id: z.string().min(1) }), handler: mailSvc.revealSecret },
    testAccount: mailSvc.testAccount, sync: mailSvc.sync, folders: mailSvc.folders,
    list: mailSvc.list, read: mailSvc.read, send: mailSvc.send, saveDraft: mailSvc.saveDraft,
    markRead: mailSvc.markRead,
    // 标记未读：与 markRead 对称，入参经 zod 校验
    // 校验后 handler 收到的是 { id }，service 只认 id 字符串
    markUnread: { schema: z.object({ id: z.string().min(1) }), handler: function (dto) { return mailSvc.markUnread(dto.id) } },
    toggleStar: mailSvc.toggleStar, remove: mailSvc.remove,
    rules: mailSvc.rules, saveRule: mailSvc.saveRule, toTodoInfo: mailSvc.toTodoInfo
  })
  registry.register('window', {
    minimize: function () { if (win) win.minimize(); return true },
    toggleMaximize: function () {
      if (!win) return false
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return win.isMaximized()
    },
    // 关闭按钮：开了「关闭到托盘」就只隐藏；否则真正退出
    close: function () {
      if (!win) return true
      if (windowPrefs().closeToTray) { win.hide(); return true }
      quitting = true
      win.close()
      return true
    },
    isMaximized: function () { return !!(win && win.isMaximized()) },
    isMinimized: function () { return !!(win && win.isMinimized()) },
    // 全屏专注：进入/退出系统级全屏（不是渲染层的覆盖层）
    setFullScreen: {
      schema: z.object({ on: z.boolean() }),
      handler: function (dto) {
        if (!win) return false
        win.setFullScreen(!!dto.on)
        return win.isFullScreen()
      }
    },
    isFullScreen: function () { return !!(win && win.isFullScreen()) }
  })
  registry.register('settings', {
    all: settingsSvc.all,
    get: settingsSvc.get,
    // 设置写入：按 section 合并，入参必须是对象
    set: {
      schema: z.record(z.string(), z.unknown()),
      handler: function (dto) {
        const out = settingsSvc.set(dto)
        // MCP 开关/端口也可能经通用设置入口写入（恢复备份、导入配置），这里补一次重载
        if (dto && dto.mcp) void syncMcp()
        // 设置变更后广播：渲染层的 store 重新拉取，主题/强调色/首页卡片立即联动
        BrowserWindow.getAllWindows().forEach(function (w) {
          if (!w.isDestroyed()) registry.broadcast(w.webContents, 'settings', 'set')
        })
        return out
      }
    },
    storage: settingsSvc.storage,
    // 备份：口令可选，只在内存态使用
    backup: { schema: z.object({ password: z.string().optional() }).optional(), handler: settingsSvc.backup },
    backups: settingsSvc.backups,
    restore: {
      schema: z.object({
        path: z.string().optional(),
        text: z.string().optional(),
        password: z.string().optional()
      }),
      handler: settingsSvc.restore
    },
    exportData: {
      schema: z.object({ kind: z.enum(['json', 'ics', 'opml', 'eml']) }),
      handler: settingsSvc.exportData
    },
    clearCache: settingsSvc.clearCache,
    clearTrash: settingsSvc.clearTrash,
    resetAll: settingsSvc.resetAll,
    setWeatherKey: { schema: z.object({ key: z.string() }), handler: settingsSvc.setWeatherKey },
    // JWT 凭据：Ed25519 私钥只在主进程解密使用，落库前经 safeStorage 加密
    setWeatherJwt: {
      schema: z.object({
        developerId: z.string().min(1),
        projectId: z.string().min(1),
        keyId: z.string().min(1),
        // 编辑已有凭据时可留空，表示沿用原私钥
        privateKey: z.string().optional()
      }),
      handler: settingsSvc.setWeatherJwt
    },
    clearWeatherJwt: settingsSvc.clearWeatherJwt,
    // 凭据明文回显：kind=weatherKey | weatherJwt，界面默认掩码
    revealSecret: { schema: z.object({ kind: z.enum(['weatherKey', 'weatherJwt']) }), handler: settingsSvc.revealSecret },
    testWeather: settingsSvc.testWeather,
    // 快递数据源凭据：values 里每个字段独立保存，空串表示删除该字段
    setParcelCredential: {
      schema: z.object({
        provider: z.enum(['kuaidi100', 'kdniao', 'juhe']),
        values: z.record(z.string(), z.string())
      }),
      handler: function (dto) {
        const out = settingsSvc.setParcelCredential(dto)
        BrowserWindow.getAllWindows().forEach(function (w) { if (!w.isDestroyed()) registry.broadcast(w.webContents, 'settings', 'set') })
        return out
      }
    },
    clearParcelCredential: {
      schema: z.object({ provider: z.enum(['kuaidi100', 'kdniao', 'juhe']) }),
      handler: function (dto) {
        const out = settingsSvc.clearParcelCredential(dto)
        BrowserWindow.getAllWindows().forEach(function (w) { if (!w.isDestroyed()) registry.broadcast(w.webContents, 'settings', 'set') })
        return out
      }
    },
    // 凭据明文回显：provider=kuaidi100 | kdniao | juhe，界面默认掩码
    revealParcelCredential: {
      schema: z.object({ provider: z.enum(['kuaidi100', 'kdniao', 'juhe']) }),
      handler: settingsSvc.revealParcelCredential
    }
  })
  // 项目计划：Agent 写入的计划的只读元信息（计划条、设置页用）
  registry.register('project', {
    planMeta: {
      schema: z.object({ listId: z.string().min(1) }),
      handler: function (dto) { return projectSvc.planMeta(dto.listId) }
    }
  })
  // MCP 控制面：开关/端口/令牌/运行状态
  registry.register('mcp', {
    status: function () { return mcpState() },
    setEnabled: {
      schema: z.object({
        enabled: z.boolean(),
        port: z.number().int().min(1024).max(65535).optional()
      }),
      handler: async function (dto) {
        // 环境变量优先时端口不落库：存了也不会生效，只会让设置页与实际监听对不上
        settingsSvc.setMcp(mcpPort().source === 'env' ? { enabled: dto.enabled } : dto)
        return syncMcp()
      }
    },
    revealToken: function () { return { token: settingsSvc.ensureMcpToken() } },
    rotateToken: function () {
      const out = settingsSvc.rotateMcpToken()
      return { token: out.token }
    }
  })
  registry.register('search', {
    query: { schema: z.object({ keyword: z.string().min(1).max(60) }), handler: searchSvc.query }
  })
  // 通知写操作后广播：首页卡片、侧栏角标、通知页都靠它实时对齐
  function broadcastNotify() {
    BrowserWindow.getAllWindows().forEach(function (w) {
      if (!w.isDestroyed()) registry.broadcast(w.webContents, 'notification', 'changed')
    })
  }
  // 番茄钟被「任务完成」自动收尾时，各窗口立即重画计时器与任务绑定
  pomodoroSvc.onStateChange(function () {
    BrowserWindow.getAllWindows().forEach(function (w) {
      if (!w.isDestroyed()) registry.broadcast(w.webContents, 'pomodoro', 'changed')
    })
  })
  registry.register('notification', {
    today: notificationSvc.today,
    unreadCount: notificationSvc.unreadCount,
    // 单条：仪表盘卡片深链定位（/notice?focus=<id>），通知不做来源数据深链
    get: { schema: z.string().min(1), handler: notificationSvc.get },
    counts: notificationSvc.counts,
    list: {
      schema: z.object({
        module: z.string().max(20).optional(),
        onlyUnread: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional()
      }).optional(),
      handler: notificationSvc.list
    },
    markAllRead: function () { const n = notificationSvc.markAllRead(); broadcastNotify(); return n },
    markRead: { schema: z.string().min(1), handler: function (id) { const ok = notificationSvc.markRead(id); broadcastNotify(); return ok } },
    clearRead: function () { const n = notificationSvc.clearRead(); broadcastNotify(); return n },
    create: notificationSvc.create,
    remove: {
      schema: z.string().min(1),
      handler: function (id) { const ok = notificationSvc.remove(id); broadcastNotify(); return ok }
    },
    // 任意模块上报一个事件：主进程统一决定系统通知/应用内通知，并做去重与免打扰判定
    push: {
      schema: z.object({
        module: z.string().min(1).max(20),
        title: z.string().min(1).max(120),
        body: z.string().max(300).optional(),
        level: z.enum(['normal', 'strong']).optional(),
        id: z.string().min(1).max(160).optional()
      }),
      handler: notifySvc.push
    },
    // 设置页「发送测试通知」：两条通道各自回结果
    test: function () { return notifySvc.test() }
  })
  registry.register('log', {
    // 渲染进程写入主进程日志文件
    write: function (dto) {
      const level = dto && dto.level ? dto.level : 'info'
      const scope = dto && dto.scope ? dto.scope : 'renderer'
      const message = dto && dto.message ? dto.message : ''
      logger.write(level, scope, message, dto && dto.meta ? dto.meta : undefined)
      return true
    },
    // 渲染进程上报异常，附带堆栈
    error: function (dto) {
      const fake = new Error(dto && dto.message ? dto.message : 'renderer error')
      fake.stack = dto && dto.stack ? dto.stack : fake.stack
      logger.error('renderer', dto && dto.scope ? dto.scope : 'ui', dto && dto.message ? dto.message : 'error', {
        stack: fake.stack,
        info: dto && dto.info ? dto.info : undefined,
        location: dto && dto.location ? dto.location : undefined,
        meta: dto && dto.meta ? dto.meta : undefined
      })
      return true
    },
    path: function () { return { file: logger.currentPath(), dir: logger.directory() } },
    files: function () { return logger.listFiles() }
  })
  // 自动更新进度：下载/安装状态推给所有窗口，设置页据此在按钮下方显示进度
  const emitUpdate = function (payload) {
    BrowserWindow.getAllWindows().forEach(function (w) {
      if (!w.isDestroyed()) w.webContents.send('update:progress', payload)
    })
  }
  registry.register('system', {
    // 数据目录与回退原因一起暴露，排查「写不进去」时不用再猜路径
    info: function () {
      return {
        version: app.getVersion(),
        userData: app.getPath('userData'),
        defaultUserData: defaultDataDir,
        dataSource: dataDir.source,
        db: conn.file()
      }
    },
    ping: function () { return 'pong' },
    // 目录选择：备份路径等由用户在本机挑选，返回 { path: null } 表示取消
    chooseDir: {
      schema: z.object({ title: z.string().optional(), defaultPath: z.string().optional() }).optional(),
      handler: async function (dto) {
        const opts = dto || {}
        const res = await dialog.showOpenDialog({
          title: opts.title || '选择目录',
          defaultPath: opts.defaultPath || app.getPath('documents'),
          properties: ['openDirectory', 'createDirectory']
        })
        if (res.canceled || !res.filePaths.length) return { path: null }
        return { path: res.filePaths[0] }
      }
    },
    openPath: function (p) { if (p) shell.openPath(String(p)); return true },
    // 开机启动：写系统登录项；开发态用当前 Electron 可执行文件 + 应用目录
    setLaunchAtLogin: {
      schema: z.object({ enabled: z.boolean() }),
      handler: function (dto) {
        const enabled = !!dto.enabled
        const opts = { openAtLogin: enabled }
        if (!app.isPackaged) {
          opts.path = process.execPath
          opts.args = [app.getAppPath()]
        }
        try {
          app.setLoginItemSettings(opts)
          return app.getLoginItemSettings().openAtLogin
        } catch (e) {
          logger.warn('system', 'launch_at_login_failed', { message: e && e.message })
          return false
        }
      }
    },
    loginItemEnabled: function () {
      try { return app.getLoginItemSettings().openAtLogin } catch (e) { return false }
    },
    // 手动定位托盘：设置页按钮调用，弹一次托盘气泡提示
    trayHint: function () {
      if (!tray || tray.isDestroyed()) return false
      hintTrayOnce(true)
      return true
    },
    // 托盘自检：确认对象是否创建、图标是否为空、系统给出的托盘区域坐标
    trayInfo: function () {
      let iconEmpty = true
      let iconSize = null
      try {
        const img = nativeImage.createFromPath(TRAY_ICON_PATH)
        iconEmpty = img.isEmpty()
        iconSize = img.getSize()
      } catch (e) {
        iconEmpty = true
      }
      let alive = false
      let bounds = null
      try {
        alive = !!tray && !tray.isDestroyed()
        bounds = alive ? tray.getBounds() : null
      } catch (e) {
        alive = false
      }
      return { created: !!tray, alive: alive, iconPath: TRAY_ICON_PATH, iconEmpty: iconEmpty, iconSize: iconSize, bounds: bounds }
    },
    // 打开外部链接：只放行 http(s)，失败（例如进程以管理员身份运行、系统拒绝默认浏览器）会把错误抛回渲染层
    openExternal: {
      schema: z.object({ url: z.string().min(1) }),
      handler: async function (dto) {
        const url = String(dto.url || '')
        if (!/^https?:\/\//i.test(url)) throw new Error('URL_NOT_ALLOWED')
        await shell.openExternal(url)
        return true
      }
    },
    // 检查更新：读 GitHub 最新发布与当前版本比对，只回数据；是否跳转由渲染层决定
    checkUpdate: function () { return updateSvc.check() },
    // 自动更新：当前下载/安装状态，设置页重新挂载时恢复进度显示
    updateStatus: function () { return updateSvc.status() },
    // 自动更新：只对 GitHub 上的正式安装包动手；开发态直接拒绝，避免装到源码目录
    downloadUpdate: async function () {
      if (!app.isPackaged) {
        const e = new Error('开发模式不执行自动更新，请到发布页手动下载')
        e.code = 'NOT_PACKAGED'
        throw e
      }
      const info = await updateSvc.check()
      if (!info.hasUpdate) return { started: false, hasUpdate: false, version: info.latest }
      if (!info.asset) return { started: false, hasUpdate: true, version: info.latest, noAsset: true }
      updateSvc.start(info, emitUpdate)
      return { started: true, hasUpdate: true, version: info.latest }
    },
    // 自动更新：启动已下载的安装包（静默安装）并退出应用
    installUpdate: function () {
      updateSvc.install(emitUpdate)
      return true
    }
  })
}

// 主进程未捕获异常与拒绝：写日志后继续运行（不静默崩溃）
process.on('uncaughtException', function (err) {
  logger.error('main', 'uncaughtException', err)
  console.error(err)
})
process.on('unhandledRejection', function (reason) {
  logger.error('main', 'unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)))
})

/* ---------- 邮件自动同步 ---------- */
// 频率取设置里的 mail.autoSyncMin（分钟，0 = 关闭，只手动同步）。
// 用 60s 轮询而不是 setTimeout 链：用户改完频率下一个 tick 即生效，
// 系统休眠唤醒后也能马上补一次，不会因为定时器停摆长期不同步。
const MAIL_TICK_MS = 60 * 1000
let mailAutoTimer = null
let mailAutoLastAt = 0
let mailAutoRunning = false

/* ---------- 快递自动刷新 ---------- */
// 频率取设置里的 parcel.autoRefreshMin（分钟，0 = 关闭，只手动刷新）；默认只刷未签收的包裹。
// 与邮件一样走 60s 轮询：用户改完频率、换完数据源，下一个 tick 就按新配置走。
const PARCEL_TICK_MS = 60 * 1000
let parcelAutoTimer = null
let parcelAutoLastAt = 0
let parcelAutoRunning = false

function parcelAutoRefreshMin() {
  const cfg = settingsSvc.get('parcel') || {}
  const v = Number(cfg.autoRefreshMin)
  return Number.isFinite(v) && v > 0 ? Math.max(5, Math.round(v)) : 0
}

// 快递列表变更后广播：页面与首页卡片都监听这个频道重新拉数据
function broadcastParcel(action) {
  BrowserWindow.getAllWindows().forEach(function (w) {
    if (w.isDestroyed()) return
    registry.broadcast(w.webContents, 'parcel', action)
  })
}

async function runParcelAutoRefresh() {
  if (parcelAutoRunning) return
  const min = parcelAutoRefreshMin()
  if (!min) return
  if (Date.now() - parcelAutoLastAt < min * 60000) return
  const cfg = settingsSvc.get('parcel') || {}
  // 手动维护模式没有可调用的接口，定时器空转只会白写 last_error
  if (!cfg.provider || cfg.provider === 'manual') return
  parcelAutoRunning = true
  parcelAutoLastAt = Date.now()
  try {
    const r = await parcelSvc.refreshAll({ force: false })
    if (r.added || r.changed) broadcastParcel('autoRefresh')
    logger.info('parcel', 'auto_refresh_done', { total: r.total, added: r.added, changed: r.changed, failed: r.failed, min: min })
  } catch (e) {
    logger.warn('parcel', 'auto_refresh_failed', { message: e && e.message })
  } finally {
    parcelAutoRunning = false
  }
}

function startParcelAutoRefresh() {
  if (parcelAutoTimer) return
  parcelAutoLastAt = 0
  parcelAutoTimer = setInterval(function () { void runParcelAutoRefresh() }, PARCEL_TICK_MS)
  // 启动后 8s 补一次：与邮件错开，避免同时打接口
  setTimeout(function () { void runParcelAutoRefresh() }, 8000)
}

function mailAutoSyncMin() {
  const cfg = settingsSvc.get('mail') || {}
  const v = Number(cfg.autoSyncMin)
  return Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v)) : 0
}

function broadcastMail(action) {
  BrowserWindow.getAllWindows().forEach(function (w) {
    if (w.isDestroyed()) return
    registry.broadcast(w.webContents, 'mail', action)
  })
}

async function runMailAutoSync() {
  if (mailAutoRunning) return
  const min = mailAutoSyncMin()
  if (!min) return
  if (Date.now() - mailAutoLastAt < min * 60000) return
  mailAutoRunning = true
  mailAutoLastAt = Date.now()
  try {
    const accts = mailSvc.accounts().filter(function (a) { return a.enabled })
    let added = 0
    let updated = 0
    for (const a of accts) {
      const r = await mailSvc.sync({ accountId: a.id })
      added += Number(r && r.added) || 0
      updated += Number(r && r.updated) || 0
    }
    logger.info('mail', 'auto_sync_done', { added: added, updated: updated, min: min })
    broadcastMail('autoSync')
  } catch (e) {
    logger.warn('mail', 'auto_sync_failed', e instanceof Error ? e : new Error(String(e)))
  } finally {
    mailAutoRunning = false
  }
}

function startMailAutoSync() {
  if (mailAutoTimer) return
  mailAutoLastAt = 0
  mailAutoTimer = setInterval(function () { void runMailAutoSync() }, MAIL_TICK_MS)
  // 启动后 5s 补一次：与「最后同步」对齐，避免开着 15 分钟也迟迟不拉
  setTimeout(function () { void runMailAutoSync() }, 5000)
}

/** 自动备份：服务层按设置判断是否到期、是否受加密限制；这里只负责调度与日志 */
function runAutoBackup(source) {
  try {
    const r = settingsSvc.autoBackup(source)
    if (r && r.created) logger.info('main', 'auto_backup_done', { source: source, name: r.created.name })
    else if (r && r.error) logger.warn('main', 'auto_backup_failed', { source: source, error: r.error })
  } catch (e) {
    logger.warn('main', 'auto_backup_failed', { source: source, message: e && e.message })
  }
}

app.whenReady().then(function () {
  // 拼写词典：Chromium 默认去 redirector.gvt1.com 拉 en-us 词典，这条链路常被重置，
  // 控制台就会刷 ssl_client_socket_impl handshake failed / net_error -100。
  // 主窗口已关掉 spellcheck，这里把会话级词典下载一并关掉，再兜底拦掉词典请求。
  try {
    const ses = session.defaultSession
    ses.setSpellCheckerEnabled(false)
    // 词典下载地址指向本机空端口：即使有组件坚持预取，也只会在本机收到 connection refused，
    // 不会再对 gvt1.com 发起 TLS 握手（国内这条链路会被重置，控制台即报 -100）。
    ses.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:1/dict/')
    ses.webRequest.onBeforeRequest({ urls: ['*://*.gvt1.com/dict/*', '*://redirector.gvt1.com/*'] }, function (details, cb) {
      cb({ cancel: true })
    })
  } catch (e) {}
  logger.init(app.getPath('userData'), { level: process.env.TK_LOG_LEVEL || 'info' })
  logger.info('main', 'app_ready', { electron: process.versions.electron, node: process.versions.node })
  if (dataDir.source !== 'default' && dataDir.source !== 'env' && dataDir.source !== 'existing') {
    logger.warn('db', 'data_dir_fallback', {
      requested: defaultDataDir, using: dataDir.dir, source: dataDir.source
    })
    console.warn('[db] 默认数据目录不可写，已改用 ' + dataDir.dir)
  }
  // 回退目录首次使用时继承旧库，避免「数据突然少了」
  const legacy = dataDir.fallbackFrom ? copyLegacyDb(dataDir.fallbackFrom, dataDir.dir) : null
  if (legacy) {
    logger.info('db', 'legacy_db_copied', legacy)
    console.log('[db] 已把旧数据库复制到新数据目录: ' + legacy.to)
  }
  const opened = conn.open(app.getPath('userData'))
  const check = conn.integrityCheck()
  seed(conn.get())
  // 凭据改为明文落库（设置页默认掩码）：库打开后把旧版 safeStorage 密文一次改写为明文
  try {
    const cfgChanged = settingsSvc.migratePlain()
    const mailChanged = mailSvc.migratePlain()
    if (cfgChanged || mailChanged) logger.info('settings', 'secret_migrated_plain', { settings: cfgChanged, mail: mailChanged })
  } catch (e) {
    logger.warn('settings', 'secret_migrate_failed', String(e && e.message))
  }
  registerIpc()
  // MCP：按设置决定是否监听本机端口；失败只记日志，不阻塞启动
  void initMcp()
  // 启动时按设置同步系统登录项，避免用户手动改过之后状态漂移
  if (windowPrefs().launchAtLogin) {
    try {
      const loginOpts = { openAtLogin: true }
      if (!app.isPackaged) { loginOpts.path = process.execPath; loginOpts.args = [app.getAppPath()] }
      app.setLoginItemSettings(loginOpts)
    } catch (e) {
      logger.warn('system', 'launch_at_login_sync_failed', { message: e && e.message })
    }
  }
  createWindow()
  // 按官方示例：ready 阶段就创建托盘（不依赖窗口 ready-to-show）
  createTray()
  // 邮件自动同步：频率读设置里的 mail.autoSyncMin，改动后下一个 tick 就按新值走
  startMailAutoSync()
  // 快递自动刷新：频率读设置里的 parcel.autoRefreshMin，换数据源后下一个 tick 生效
  startParcelAutoRefresh()
  // 自动备份：启动后先检查一次是否到期，运行中每 30 分钟检查，退出时由 before-quit 再触发
  setTimeout(function () { runAutoBackup('startup') }, 8000)
  setInterval(function () { runAutoBackup('timer') }, 30 * 60 * 1000)
  // 事件通知引擎：系统通知 + 应用内通知。窗口对象每次重建都取最新的，所以传函数而不是引用
  notifySvc.start({
    getWindow: function () { return win },
    icon: ICON_PATH,
    publish: function (payload) {
      BrowserWindow.getAllWindows().forEach(function (w) {
        if (w.isDestroyed()) return
        registry.broadcast(w.webContents, 'notification', 'push')
        w.webContents.send('notify:event', payload)
      })
    },
    navigate: function (to) {
      showMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send('app:navigate', to)
    }
  })
  app.on('second-instance', function () { logger.info('main', 'second_instance'); showMainWindow() })
  console.log('[db] file=' + opened.file + ' version=' + opened.version + ' applied=' + JSON.stringify(opened.applied) + ' integrity=' + check.ok)
  logger.info('db', 'opened', { file: opened.file, version: opened.version, applied: opened.applied, integrity: check.ok, dataSource: dataDir.source })
  app.on('activate', function () { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', function () { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', function () {
  // 「每次退出」在这里落盘；quitting 兼作重复触发保护，避免连按关闭生成多份
  if (!quitting) runAutoBackup('quit')
  quitting = true
  notifySvc.stop()
  stopMcp()
  // Windows 下进程退出后托盘图标可能残留在通知区直到鼠标划过，主动销毁
  if (tray && !tray.isDestroyed()) { try { tray.destroy() } catch (e) {} }
  logger.info('main', 'app_quit')
  logger.flush()
  conn.close()
})
