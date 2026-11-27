#!/usr/bin/env node
'use strict'
// 更新功能开发验证的总入口：一条命令跑服务层与渲染层两组无头断言。
//   npm run verify:update
// 前置：先 npm run build（需要 dist/ 给 vite preview 用）。
// 全程不联网、不安装真实包、不弹窗：假 release 服务跑在 127.0.0.1。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const PREVIEW_PORT = 4179
const HARNESS_TIMEOUT_MS = 300000

function baseEnv(extra) {
  const env = Object.assign({}, process.env, extra || {})
  // ELECTRON_RUN_AS_NODE=1 会让 Electron 退化成纯 Node（app 为 undefined）
  for (const k of Object.keys(env)) { if (k.startsWith('ELECTRON_')) delete env[k] }
  env.FORCE_COLOR = '0'
  return env
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '')
}

// 起 vite preview 并用它打印的地址（端口被占时 --strictPort 会直接报错）
function startPreview() {
  const child = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv(),
    windowsHide: true
  })
  return new Promise(function (resolve, reject) {
    let buf = ''
    const timer = setTimeout(function () {
      reject(new Error('vite preview 30s 内没有就绪：' + stripAnsi(buf).slice(-600)))
    }, 30000)
    child.stdout.on('data', function (d) {
      buf += String(d)
      const m = stripAnsi(buf).match(/Local:\s*(http:\/\/[^\s]+)/)
      if (m) {
        clearTimeout(timer)
        resolve({ child: child, url: m[1].replace(/\/+$/, '') })
      }
    })
    child.stderr.on('data', function (d) { buf += String(d) })
    child.on('exit', function (code) {
      clearTimeout(timer)
      const tail = stripAnsi(buf).slice(-600)
      if (tail.indexOf('Local:') < 0) reject(new Error('vite preview 退出（code=' + code + '）：' + tail))
    })
    child.on('error', function (e) {
      clearTimeout(timer)
      reject(new Error('vite preview 启动失败：' + ((e && e.message) || e)))
    })
  })
}

// Electron 用「应用目录」方式启动：目录里放 package.json 指向无头脚本，
// 这样 app.getVersion() 读到的是本项目版本（直接 electron <script> 会读成 Electron 自己的版本）。
function prepareAppDir(scriptRel) {
  const dir = path.join(root, '.data', 'headless', 'app-' + path.basename(scriptRel, '.cjs'))
  fs.mkdirSync(dir, { recursive: true })
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const main = path.join(root, scriptRel).split(path.sep).join('/')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'something-verify-' + path.basename(scriptRel, '.cjs'),
    version: rootPkg.version,
    private: true,
    main: main
  }, null, 2) + '\n')
  return dir
}

// 跑一个 Electron 无头脚本，实时转发输出，返回退出码与全部输出
function runElectron(scriptRel, envExtra) {
  return new Promise(function (resolve) {
    const appDir = prepareAppDir(scriptRel)
    const args = [electronCli, appDir, '--no-sandbox', '--disable-gpu']
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: baseEnv(envExtra),
      windowsHide: true
    })
    let out = ''
    const timer = setTimeout(function () {
      console.error('[verify] ' + scriptRel + ' 超过 ' + Math.round(HARNESS_TIMEOUT_MS / 1000) + 's，强制结束')
      try { child.kill() } catch (e) { /* ignore */ }
    }, HARNESS_TIMEOUT_MS)
    const forward = function (stream, target) {
      stream.on('data', function (d) {
        const text = String(d)
        out += text
        target.write(text)
      })
    }
    forward(child.stdout, process.stdout)
    forward(child.stderr, process.stderr)
    child.on('exit', function (code) {
      clearTimeout(timer)
      resolve({ code: code == null ? 1 : code, out: out })
    })
    child.on('error', function (e) {
      clearTimeout(timer)
      resolve({ code: 1, out: out + '\n[verify] spawn error: ' + ((e && e.message) || e) })
    })
  })
}

function countResults(out) {
  let pass = 0
  let fail = 0
  for (const line of out.split(/\r?\n/)) {
    if (/^PASS /.test(line)) pass++
    else if (/^FAIL /.test(line)) fail++
  }
  return { pass: pass, fail: fail }
}

async function main() {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    console.error('[verify] 找不到 dist/index.html，先执行 npm run build')
    process.exit(1)
  }

  console.log('[verify] 1/2 服务层：真实下载、白名单、错误分支、安装命令')
  const svc = await runElectron('scripts/headless-update-service.cjs', {})

  console.log('[verify] 2/2 渲染层：弹窗、进度、就绪、失败重试、通知与偏好')
  let preview = null
  let ui = { code: 1, out: '' }
  try {
    preview = await startPreview()
    console.log('[verify] vite preview -> ' + preview.url)
    ui = await runElectron('scripts/headless-update-ui.cjs', {
      VITE_URL: preview.url,
      STUB_STATE_FILE: path.join(root, '.data', 'headless', 'stub-state.json')
    })
  } catch (e) {
    console.error('[verify] ' + ((e && e.message) || e))
    ui = { code: 1, out: '' }
  } finally {
    if (preview) {
      try { preview.child.kill() } catch (e) { /* ignore */ }
    }
  }

  const svcCount = countResults(svc.out)
  const uiCount = countResults(ui.out)
  const pass = svcCount.pass + uiCount.pass
  const fail = svcCount.fail + uiCount.fail
  const bad = fail > 0 || svc.code !== 0 || ui.code !== 0

  console.log('')
  console.log('================ verify:update ================')
  console.log('服务层  pass=' + svcCount.pass + ' fail=' + svcCount.fail + ' exit=' + svc.code)
  console.log('渲染层  pass=' + uiCount.pass + ' fail=' + uiCount.fail + ' exit=' + ui.code)
  console.log('合计    pass=' + pass + ' fail=' + fail + ' -> ' + (bad ? 'FAILED' : 'OK'))
  if (!ui.out) console.log('渲染层没有产出断言结果（preview 或 Electron 起不来），看上面的日志。')
  console.log('==============================================')
  process.exit(bad ? 1 : 0)
}

main().catch(function (e) {
  console.error('[verify] fatal: ' + ((e && e.stack) || e))
  process.exit(1)
})
