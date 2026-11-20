// Electron 主进程：窗口、数据库生命周期、IPC 注册。
const { app, BrowserWindow, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { z } = require('zod')

// 最早的启动标记：写入 boot.txt，用于区分「主进程没加载」与「加载后崩溃」。
// 若某次启动失败但 boot.txt 没有新行，说明崩在 Chromium 初始化阶段（GPU/沙箱）。
try {
  const dirBoot = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dirBoot, { recursive: true })
  fs.appendFileSync(path.join(dirBoot, 'boot.txt'), new Date().toISOString() + ' main.js loaded pid=' + process.pid + '\n')
} catch (e) {}
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

const isDev = !app.isPackaged
let win = null
let registry = null

// 数据目录解析（必须在 app ready 之前完成）：
// 默认用 userData；若它不可写（受限沙箱 / 只读配置目录 / 安全软件拦截），
// 回退到应用目录下的 .data，否则 SQLite 打开后一写就报
// "attempt to write a readonly database"，日志也会静默丢失。
// 仍可用 TK_DATA_DIR 显式指定（此时不做回退，路径不可写就按原样报错）。
const defaultDataDir = app.getPath('userData')
const dataCandidates = [
  path.join(app.getAppPath(), '.data'),
  path.join(path.dirname(app.getPath('exe')), 'data'),
  path.join(app.getPath('temp'), 'efficiency-toolkit')
]
const dataDir = pickDataDir({
  override: process.env.TK_DATA_DIR,
  defaultDir: defaultDataDir,
  // 已经回退过一次的目录里若已有库，就固定用它，避免两次启动落到不同位置
  stickyDir: dataCandidates[0],
  candidates: dataCandidates
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


function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: '效率工具集',
    backgroundColor: '#f5f7fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 开发期加载本地 Vite 服务，关闭不需要的能力，减少无谓网络探测
      webSecurity: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', function () { win.show() })
  if (isDev) {
    win.loadURL(process.env.VITE_URL || 'http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  win.webContents.setWindowOpenHandler(function (d) {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })
  win.on('closed', function () { win = null })
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
    stats: todoSvc.stats
  })
  registry.register('schedule', {
    range: scheduleSvc.range, get: scheduleSvc.get, create: scheduleSvc.create,
    update: scheduleSvc.update, remove: scheduleSvc.remove,
    checkConflict: scheduleSvc.checkConflict,
    calendars: scheduleSvc.calendars, toggleCalendar: scheduleSvc.toggleCalendar,
    createCalendar: scheduleSvc.createCalendar, removeCalendar: scheduleSvc.removeCalendar,
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
    fetch: weatherSvc.fetch
  })
  registry.register('feed', {
    groups: feedSvc.groups, addGroup: feedSvc.addGroup,
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
    toggleStar: feedSvc.toggleStar, toggleLater: feedSvc.toggleLater,
    refresh: feedSvc.refresh, importOPML: feedSvc.importOPML, exportOPML: feedSvc.exportOPML
  })
  registry.register('parcel', {
    list: parcelSvc.list, add: parcelSvc.add, refresh: parcelSvc.refresh,
    tracks: parcelSvc.tracks, archive: parcelSvc.archive,
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
    testAccount: mailSvc.testAccount, sync: mailSvc.sync, folders: mailSvc.folders,
    list: mailSvc.list, read: mailSvc.read, send: mailSvc.send, saveDraft: mailSvc.saveDraft,
    markRead: mailSvc.markRead, toggleStar: mailSvc.toggleStar, remove: mailSvc.remove,
    rules: mailSvc.rules, saveRule: mailSvc.saveRule, toTodoInfo: mailSvc.toTodoInfo
  })
  registry.register('settings', {
    all: settingsSvc.all,
    get: settingsSvc.get,
    // 设置写入：按 section 合并，入参必须是对象
    set: { schema: z.record(z.string(), z.unknown()), handler: settingsSvc.set },
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
    testWeather: settingsSvc.testWeather
  })
  registry.register('notification', {
    today: notificationSvc.today,
    unreadCount: notificationSvc.unreadCount,
    markAllRead: notificationSvc.markAllRead,
    create: notificationSvc.create,
    remove: { schema: z.string().min(1), handler: notificationSvc.remove }
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
    // 打开外部链接：只放行 http(s)，失败（例如进程以管理员身份运行、系统拒绝默认浏览器）会把错误抛回渲染层
    openExternal: {
      schema: z.object({ url: z.string().min(1) }),
      handler: async function (dto) {
        const url = String(dto.url || '')
        if (!/^https?:\/\//i.test(url)) throw new Error('URL_NOT_ALLOWED')
        await shell.openExternal(url)
        return true
      }
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

app.whenReady().then(function () {
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
  registerIpc()
  createWindow()
  console.log('[db] file=' + opened.file + ' version=' + opened.version + ' applied=' + JSON.stringify(opened.applied) + ' integrity=' + check.ok)
  logger.info('db', 'opened', { file: opened.file, version: opened.version, applied: opened.applied, integrity: check.ok, dataSource: dataDir.source })
  app.on('activate', function () { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', function () { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', function () {
  logger.info('main', 'app_quit')
  logger.flush()
  conn.close()
})
