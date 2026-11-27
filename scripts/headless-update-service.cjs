#!/usr/bin/env node
'use strict'
// 服务层无头验证：直接在 Electron 主进程里跑 electron/services/update.cjs，
// 用本机假 release 服务（scripts/update-fixture.cjs）验证真实的 HTTP 下载、
// 白名单、错误分支与安装命令参数。不建窗口、不联网、不真装。
// 由 scripts/verify-update.cjs 用 electron 拉起：electron scripts/headless-update-service.cjs
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const MB = 1024 * 1024
const root = path.join(__dirname, '..')
const sandboxDir = path.join(os.tmpdir(), 'something-verify-update-svc')

// 隔离用户数据目录，避免污染用户真实的配置与日志
try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
app.setPath('userData', sandboxDir)

const update = require(path.join(root, 'electron', 'services', 'update.cjs'))
const testHooks = update.__test

const results = []
const children = []

function record(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || '' })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : ' :: ' + detail))
}

async function scenario(name, fn) {
  try {
    await fn()
    record(name, true)
  } catch (e) {
    record(name, false, (e && e.message) || String(e))
  }
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms) })
}

function must(cond, message) {
  if (!cond) throw new Error(message)
}

// 起一个假 release 服务，等它打印实际监听地址
function startFixture(args) {
  const child = spawn(process.execPath, [path.join(__dirname, 'update-fixture.cjs')].concat(args), {
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  children.push(child)
  return new Promise(function (resolve, reject) {
    let buf = ''
    const timer = setTimeout(function () { reject(new Error('fixture did not start in 10s: ' + buf.slice(-300))) }, 10000)
    child.stdout.on('data', function (d) {
      buf += String(d)
      const m = buf.match(/FIXTURE_READY (\S+)/)
      if (m) {
        clearTimeout(timer)
        resolve({ child: child, base: m[1] })
      }
    })
    child.stderr.on('data', function (d) { buf += String(d) })
    child.on('exit', function (code) {
      if (buf.indexOf('FIXTURE_READY') < 0) {
        clearTimeout(timer)
        reject(new Error('fixture exited ' + code + ': ' + buf.slice(-300)))
      }
    })
  })
}

// 把服务端点指向某个假服务；reset() 清掉端点缓存与上一次的下载任务
function pointAt(base) {
  process.env.SOMETHING_UPDATE_LATEST_API = base + '/latest'
  process.env.SOMETHING_UPDATE_ALLOWED_HOSTS = '127.0.0.1'
  testHooks.reset()
}

function pointAtOfficial() {
  delete process.env.SOMETHING_UPDATE_LATEST_API
  delete process.env.SOMETHING_UPDATE_ALLOWED_HOSTS
  testHooks.reset()
}

async function waitForState(wanted, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000)
  while (Date.now() < deadline) {
    const s = update.status()
    if (s.state === wanted) return s
    if (s.state === 'error') return s
    await sleep(50)
  }
  return update.status()
}

async function expectDownloadError(fixtureArgs, needle) {
  const fx = await startFixture(fixtureArgs)
  pointAt(fx.base)
  update.start({ latest: '9.9.9', asset: { url: fx.base + '/setup.exe', size: 4 * MB } }, null)
  const st = await waitForState('ready', 20000)
  must(st.state === 'error', 'expected error state, got ' + st.state)
  must(String(st.message || '').indexOf(needle) >= 0, 'message "' + st.message + '" does not contain "' + needle + '"')
  must(fs.existsSync(path.join(app.getPath('temp'), 'something-update', 'Something-Setup-9.9.9.exe.part')) === false, 'part file left behind')
}

async function run() {
  console.log('[service] electron ' + process.versions.electron + ', app version ' + app.getVersion())

  // 1) 正常 release：字段解析、更新判定、资产挑选、更新日志截断
  await scenario('check: parses latest release', async function () {
    const fx = await startFixture(['--port', '9930', '--version', '9.9.9', '--size', String(4 * MB), '--chunk-delay', '40'])
    pointAt(fx.base)
    const r = await update.check()
    must(r.current === app.getVersion(), 'current mismatch: ' + r.current)
    must(r.latest === '9.9.9', 'latest mismatch: ' + r.latest)
    must(r.hasUpdate === true, 'hasUpdate should be true')
    must(r.asset && r.asset.url === fx.base + '/setup.exe', 'asset url mismatch')
    must(r.asset.size === 4 * MB, 'asset size mismatch: ' + r.asset.size)
    must(r.noRelease === false, 'noRelease should be false')
    must(/新增/.test(r.notes), 'notes should carry release body')
  })

  // 2) 没有发布：404 要转成 noRelease，而不是抛错
  await scenario('check: 404 becomes noRelease', async function () {
    const fx = await startFixture(['--port', '9931', '--fail', '404'])
    pointAt(fx.base)
    const r = await update.check()
    must(r.noRelease === true, 'noRelease should be true')
    must(r.hasUpdate === false, 'hasUpdate should be false')
  })

  // 3) 服务端 5xx：抛 HTTP_500，交给渲染层显示可重试错误
  await scenario('check: 500 throws HTTP_500', async function () {
    const fx = await startFixture(['--port', '9932', '--fail', '500'])
    pointAt(fx.base)
    let message = ''
    try { await update.check() } catch (e) { message = String((e && e.message) || '') }
    must(message.indexOf('HTTP_500') === 0, 'unexpected error: ' + message)
  })

  // 4) 一直不响应：8s 后 abort，不能把窗口卡死
  await scenario('check: timeout aborts', async function () {
    const fx = await startFixture(['--port', '9933', '--fail', 'hang'])
    pointAt(fx.base)
    const started = Date.now()
    let threw = false
    try { await update.check() } catch (e) { threw = true }
    const cost = Date.now() - started
    must(threw, 'check should throw on timeout')
    must(cost >= 7000 && cost <= 12000, 'timeout took ' + cost + 'ms, expected ~8000ms')
  })

  // 5) 正常下载：进度单调、大小一致、MZ 头、无 .part 残留
  await scenario('download: streams to ready', async function () {
    const fx = await startFixture(['--port', '9934', '--size', String(4 * MB), '--chunk-delay', '40'])
    pointAt(fx.base)
    const seen = []
    update.start({ latest: '9.9.9', asset: { url: fx.base + '/setup.exe', size: 4 * MB } }, function (s) {
      if (s && s.state === 'downloading') seen.push(s.percent)
    })
    const st = await waitForState('ready', 30000)
    must(st.state === 'ready', 'state ' + st.state + ' ' + (st.message || ''))
    const file = path.join(app.getPath('temp'), 'something-update', 'Something-Setup-9.9.9.exe')
    must(fs.existsSync(file), 'downloaded file missing')
    must(fs.statSync(file).size === 4 * MB, 'size mismatch: ' + fs.statSync(file).size)
    must(fs.existsSync(file + '.part') === false, '.part left behind')
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(2)
    try { fs.readSync(fd, head, 0, 2, 0) } finally { fs.closeSync(fd) }
    must(head.toString('latin1') === 'MZ', 'missing MZ header')
    must(seen.length > 0, 'no progress samples')
    for (let i = 1; i < seen.length; i++) {
      must(seen[i] >= seen[i - 1], 'progress went backwards: ' + seen.join(','))
    }
    fs.rmSync(file, { force: true })
  })

  // 6) 传输中断：连接被掐断要落到 error 且清掉半成品
  await scenario('download: truncated stream fails', async function () {
    await expectDownloadError(['--port', '9935', '--size', String(4 * MB), '--chunk-delay', '20', '--fail', 'truncate'], '下载中断')
  })

  // 7) 下到的不是安装包：MZ 校验拦截
  await scenario('download: non-MZ payload rejected', async function () {
    await expectDownloadError(['--port', '9936', '--size', String(4 * MB), '--chunk-delay', '0', '--fail', 'badmz'], '安装程序')
  })

  // 8) 内容过小：当成错误页面拦下
  await scenario('download: tiny payload rejected', async function () {
    await expectDownloadError(['--port', '9937', '--size', String(4 * MB), '--chunk-delay', '0', '--fail', 'small'], '不一致')
  })

  // 9) 白名单纯函数：https 放行，http 只有开发期 + 回环才放行
  await scenario('whitelist: http needs dev flag and loopback', async function () {
    const hosts = ['127.0.0.1', 'github.com']
    must(testHooks.hostAllowedWith(hosts, 'http://127.0.0.1:9934/setup.exe', true) === true, 'loopback http should pass in dev')
    must(testHooks.hostAllowedWith(hosts, 'http://127.0.0.1:9934/setup.exe', false) === false, 'loopback http must fail when dev flag off')
    must(testHooks.hostAllowedWith(hosts, 'http://192.168.1.20/setup.exe', true) === false, 'LAN http must fail')
    must(testHooks.hostAllowedWith(hosts, 'https://evil.example.com/x.exe', true) === false, 'unknown https host must fail')
    must(testHooks.hostAllowedWith(hosts, 'https://objects.githubusercontent.com/x.exe', false) === false, 'non-listed host must fail')
    must(testHooks.hostAllowedWith(hosts, 'https://github.com/x.exe', false) === true, 'github https should pass')
    must(testHooks.hostAllowedWith(['objects.githubusercontent.com'], 'https://objects.githubusercontent.com/x.exe', false) === true, 'subpath host should pass')
  })

  // 10) 官方端点下，指向本机的下载地址必须被拒（证明下载端也走白名单）
  await scenario('download: rejects non-whitelisted url before network', async function () {
    pointAtOfficial()
    update.start({ latest: '9.9.9', asset: { url: 'http://127.0.0.1:9934/setup.exe', size: 4 * MB } }, null)
    const st = await waitForState('ready', 8000)
    must(st.state === 'error', 'expected error, got ' + st.state)
    must(String(st.message || '').indexOf('不在 GitHub 域内') >= 0, 'unexpected message: ' + st.message)
  })

  // 11) 开发模式不执行安装：装不了要明确报 NOT_PACKAGED，而不是静默无反应
  await scenario('install: dev mode reports NOT_PACKAGED', function () {
    let code = ''
    try {
      update.install(null)
    } catch (e) {
      code = (e && e.code) || ''
    }
    must(code === 'NOT_PACKAGED', 'expected NOT_PACKAGED, got "' + code + '"')
  })

  // 12) 安装命令参数：静默 + 升级路径 + 装完自动重启
  await scenario('install: command args', function () {
    const cmd = testHooks.installCommand('C:/tmp/Something-Setup-9.9.9.exe')
    must(cmd.file === 'C:/tmp/Something-Setup-9.9.9.exe', 'file mismatch')
    must(JSON.stringify(cmd.args) === JSON.stringify(['/S', '--updated', '--force-run']), 'args mismatch: ' + JSON.stringify(cmd.args))
    must(cmd.options.detached === true && cmd.options.windowsHide === true, 'spawn options mismatch')
  })

  // 13) 打包后环境变量覆盖必须失效（防止正式版被环境变量引到别的服务）
  await scenario('endpoints: packaged ignores env overrides', function () {
    const ep = testHooks.resolveEndpoints({
      SOMETHING_UPDATE_LATEST_API: 'http://evil.local/latest',
      SOMETHING_UPDATE_ALLOWED_HOSTS: 'evil.local'
    }, true)
    must(ep.latestApi === 'https://api.github.com/repos/LijunTong/Something/releases/latest', 'packaged latestApi must be official: ' + ep.latestApi)
    must(JSON.stringify(ep.hosts) === JSON.stringify(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']), 'packaged hosts must be official')
    must(ep.allowHttp === false, 'packaged must not allow http')
  })

  // 14) 开发期环境变量生效（前面各场景正是靠它指向假服务）
  await scenario('endpoints: dev honours env overrides', function () {
    const ep = testHooks.resolveEndpoints({
      SOMETHING_UPDATE_LATEST_API: 'http://127.0.0.1:9934/latest',
      SOMETHING_UPDATE_ALLOWED_HOSTS: '127.0.0.1, github.com'
    }, false)
    must(ep.latestApi === 'http://127.0.0.1:9934/latest', 'dev latestApi mismatch')
    must(ep.hosts.length === 2 && ep.allowHttp === true, 'dev hosts mismatch')
  })

  const failed = results.filter(function (r) { return !r.ok })
  console.log('SERVICE_RESULT pass=' + (results.length - failed.length) + ' fail=' + failed.length)
  if (failed.length) {
    failed.forEach(function (f) { console.log('  - ' + f.name + ' :: ' + f.detail) })
  }
}

function cleanup() {
  children.forEach(function (c) {
    try { c.kill() } catch (e) { /* ignore */ }
  })
  try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  try { fs.rmSync(path.join(app.getPath('temp'), 'something-update'), { recursive: true, force: true }) } catch (e) { /* ignore */ }
}

app.whenReady().then(function () {
  return run()
}).catch(function (e) {
  console.error('[service] fatal: ' + ((e && e.stack) || e))
  record('fatal', false, (e && e.message) || String(e))
}).then(function () {
  cleanup()
  const failed = results.filter(function (r) { return !r.ok }).length
  app.exit(failed ? 1 : 0)
})
