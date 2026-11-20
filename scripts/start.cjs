// 直接启动 Electron 桌面应用，清理会破坏 GUI 的环境变量。
const { spawn } = require('node:child_process')
const path = require('node:path')

// __dirname 是 scripts/，项目根目录要往上一层（之前误写成 __dirname，
// 导致 cwd 落在 scripts/ 找不到 electron/main.cjs）。
const root = path.resolve(__dirname, '..')
const exe = path.join(root, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')

// Chromium 沙箱初始化失败：0x80000003 (STATUS_BREAKPOINT)，
// Node 侧是 2147483651，PowerShell 侧是 -2147483645。
// 这时 main.cjs 还没执行，只能命令行补 --no-sandbox 重试。
const SANDBOX_CRASH_CODES = new Set([2147483651, -2147483645])
const CRASH_RETRY_WINDOW = 20000

const env = { ...process.env }
// ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node，窗口起不来
for (const k of Object.keys(env)) { if (k.startsWith('ELECTRON_')) delete env[k] }

function launch(noSandbox) {
  const args = ['.']
  if (noSandbox) {
    console.log('[start] 以 --no-sandbox 启动 Electron')
    args.push('--no-sandbox')
  }
  const startedAt = Date.now()
  const child = spawn(exe, args, { cwd: root, stdio: 'inherit', env, windowsHide: false })

  child.on('error', function (err) {
    console.error('[start] 启动失败: ' + err.message)
    process.exit(1)
  })
  child.on('close', function (code) {
    const crashedFast = code != null && SANDBOX_CRASH_CODES.has(code) && Date.now() - startedAt < CRASH_RETRY_WINDOW
    if (crashedFast && !noSandbox) {
      console.warn('[start] Electron 启动即崩溃 (code=' + code + ')：Chromium 沙箱初始化失败，改用 --no-sandbox 重试。')
      launch(true)
      return
    }
    process.exit(code == null ? 1 : code)
  })
  for (const s of ['SIGINT', 'SIGTERM']) {
    process.once(s, function () { if (!child.killed) child.kill(s) })
  }
}

launch(process.env.TK_NO_SANDBOX === '1')
