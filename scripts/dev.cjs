// scripts/dev.cjs
// Boots Vite and Electron together; passes the real Vite URL to Electron.
// Vite may fall back to another port when 5173 is busy, so the URL is parsed
// from Vite's own output instead of being hard-coded in the main process.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
// 恢复 cli.js 启动方式：2026-11-20 00:53 用此方式成功弹窗过。
// 'direct spawn electron.exe' 在部分环境反而触发 Chromium STATUS_BREAKPOINT。
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js')

// Chromium 沙箱初始化失败时的退出码：
//   Windows 原样是 0x80000003 (STATUS_BREAKPOINT)，Node 侧看到 2147483651，
//   PowerShell / Start-Process 直接给负数 -2147483645。
// 这个崩溃发生在 electron/main.cjs 执行之前（主进程日志、boot.txt 都不会有新记录），
// 所以 main.cjs 里的 app.commandLine.appendSwitch('no-sandbox') 来不及生效，
// 只能在命令行上带 --no-sandbox 重新拉起来。
const SANDBOX_CRASH_CODES = new Set([2147483651, -2147483645])
// 只有「启动后很快崩溃」才判定为沙箱问题，正常使用时用户关窗口不重试。
const CRASH_RETRY_WINDOW = 20000

let vite = null
let electron = null
let stopping = false
let viteOutput = ''
let readyTimer = null
let currentUrl = ''
let restarting = false
const mainWatchers = []
let mainPollTimer = null

function buildEnv(url) {
  const env = { ...process.env, VITE_URL: url, NODE_ENV: 'development' }
  // 关键：宿主环境预设 ELECTRON_RUN_AS_NODE=1 时，Electron 会退化成纯 Node，
  // app 为 undefined、窗口起不来。必须在启动二进制前彻底清掉。
  // 同时清掉所有以 ELECTRON_ 开头的可能干扰变量，保留下面显式设置的 VITE_URL。
  for (const k of Object.keys(env)) { if (k.startsWith('ELECTRON_')) delete env[k] }
  // 透传宿主环境下的沙箱/GPU 规避开关
  // 透传 GPU 与沙箱相关开关（主进程默认已关闭硬件加速）
  for (const k of ['TK_ENABLE_GPU', 'TK_NO_SANDBOX']) {
    if (process.env[k]) env[k] = process.env[k]
  }
  return env
}

function startElectron(url) {
  if (electron || stopping) return
  if (readyTimer) clearTimeout(readyTimer)
  currentUrl = url
  watchMain(url)
  console.log('[dev] Vite ready at ' + url + '; starting Electron...')
  console.log('[dev] 启动诊断: cli=' + electronCli + ' | ELECTRON_RUN_AS_NODE=' + String(process.env.ELECTRON_RUN_AS_NODE))
  // TK_NO_SANDBOX=1 时直接跳过沙箱，避免先崩一次再重试。
  launchElectron(url, process.env.TK_NO_SANDBOX === '1')
}

function launchElectron(url, noSandbox) {
  if (stopping) return
  const args = [electronCli, '.']
  if (noSandbox) args.push('--no-sandbox')
  if (noSandbox) console.log('[dev] 以 --no-sandbox 启动 Electron')
  const startedAt = Date.now()
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: buildEnv(url),
  })
  electron = child
  child.on('exit', function (code, signal) {
    if (stopping || electron !== child) return
    const crashedFast = code != null && SANDBOX_CRASH_CODES.has(code) && Date.now() - startedAt < CRASH_RETRY_WINDOW
    if (crashedFast && !noSandbox) {
      const hex = code < 0 ? (code >>> 0).toString(16) : code.toString(16)
      console.warn('[dev] Electron 启动即崩溃 (code=' + code + ' / 0x' + hex + ')：Chromium 沙箱初始化失败。')
      console.warn('[dev] 自动改用 --no-sandbox 重试（仅影响本地开发，不改打包配置）。')
      electron = null
      launchElectron(url, true)
      return
    }
    console.log('[dev] Electron exited (code=' + code + ', signal=' + signal + '); stopping Vite.')
    stop(code == null ? 0 : code)
  })
  child.on('error', function (err) {
    console.error('[dev] Failed to start Electron: ' + err.message)
    stop(1)
  })
}

function startVite() {
  vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  vite.stdout.on('data', function (buf) {
    const text = buf.toString()
    viteOutput += text
    process.stdout.write(text)
    if (!electron) {
      const clean = viteOutput.replace(/\x1b\[[0-9;]*m/g, '')
      const match = clean.match(/Local:\s*(http:\/\/[^\s]+)/)
      if (match) startElectron(match[1].replace(/\/+$/, ''))
    }
  })
  vite.stderr.on('data', function (buf) { process.stderr.write(buf.toString()) })

  vite.on('error', function (err) {
    console.error('[dev] Failed to start Vite: ' + err.message)
    stop(1)
  })
  vite.on('exit', function (code, signal) {
    if (stopping) return
    console.error('[dev] Vite exited (code=' + code + ', signal=' + signal + '); stopping Electron.')
    stop(code == null ? 1 : code)
  })
}

// —— 主进程文件监听：electron/ 与 migrations/ 变更后自动重启 Electron ——
// 渲染层由 Vite HMR 处理，这里只管主进程 / preload / SQL 迁移。
// TK_POLL=1 时改用 mtime 轮询（Windows 上原子写、同步盘、杀软都可能让 fs.watch 丢事件）。
function collectMainFiles() {
  const wanted = /\.(cjs|js|sql)$/
  const out = []
  const walk = function (dir) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules') walk(full)
      } else if (wanted.test(ent.name)) {
        out.push(full)
      }
    }
  }
  for (const dir of ['electron', 'migrations']) walk(path.join(root, dir))
  return out
}

function restartElectron(url) {
  if (stopping || restarting || !electron) return
  restarting = true
  const child = electron
  electron = null
  // 主动重启不能落到 launchElectron 里的 exit 处理上，否则会把 Vite 一起停掉。
  child.removeAllListeners('exit')
  child.removeAllListeners('error')
  console.log('[dev] 重启 Electron…')
  try { child.kill() } catch (err) {}
  setTimeout(function () {
    restarting = false
    if (stopping) return
    launchElectron(url, process.env.TK_NO_SANDBOX === '1')
  }, 500)
}

function watchMain(url) {
  if (mainWatchers.length || mainPollTimer) return
  const trigger = function (rel) {
    if (stopping) return
    console.log('[dev] 主进程文件变更：' + rel)
    restartElectron(url)
  }
  if (process.env.TK_POLL === '1') {
    const stamps = new Map()
    for (const file of collectMainFiles()) {
      try { stamps.set(file, fs.statSync(file).mtimeMs) } catch (err) {}
    }
    console.log('[dev] 主进程监听：轮询模式（TK_POLL=1，600ms）')
    mainPollTimer = setInterval(function () {
      for (const file of collectMainFiles()) {
        let mtime = 0
        try { mtime = fs.statSync(file).mtimeMs } catch (err) { continue }
        const prev = stamps.get(file)
        stamps.set(file, mtime)
        if (prev !== mtime) trigger(path.relative(root, file))
      }
    }, 600)
    if (mainPollTimer.unref) mainPollTimer.unref()
    return
  }
  console.log('[dev] 主进程监听：文件事件模式')
  for (const dir of ['electron', 'migrations']) {
    const full = path.join(root, dir)
    if (!fs.existsSync(full)) continue
    try {
      mainWatchers.push(fs.watch(full, { recursive: true }, function (_event, file) {
        if (!file) return
        if (!/\.(cjs|js|sql)$/.test(String(file))) return
        trigger(path.join(dir, String(file)))
      }))
    } catch (err) {
      console.warn('[dev] 无法监听 ' + dir + '：' + err.message)
    }
  }
}

function stop(code) {
  if (stopping) return
  stopping = true
  if (readyTimer) clearTimeout(readyTimer)
  for (const watcher of mainWatchers) {
    try { watcher.close() } catch (err) {}
  }
  if (mainPollTimer) clearInterval(mainPollTimer)

  const children = [electron, vite].filter(Boolean)
  if (children.length === 0) {
    process.exit(code)
    return
  }
  let remaining = children.length
  const done = function () { if (--remaining === 0) process.exit(code) }
  for (const child of children) {
    child.once('exit', done)
    try { child.kill('SIGTERM') } catch (err) { done() }
  }
  setTimeout(function () { process.exit(code) }, 3000).unref()
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, function () { stop(0) })
}

readyTimer = setTimeout(function () {
  if (!electron) {
    console.error('[dev] Timed out waiting for Vite to become ready (30s).')
    stop(1)
  }
}, 30000)

startVite()
