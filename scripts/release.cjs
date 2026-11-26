// scripts/release.cjs
// One-command release: typecheck -> build -> package -> tag -> push -> GitHub Release.
//
// Resumable: progress is written per version to release/.release-state/v<version>.json.
// A failed or interrupted run (build error, push rejected, upload timeout, Ctrl+C) is
// continued from where it stopped on the next `npm run release`; the confirmed release
// message is part of that file too, so manual edits survive a retry.
//
// Guards: must run on master, clean working tree, tag name = v + package.json version.
//
// Usage:
//   node scripts/release.cjs                        # full release, asks before pushing the tag
//   node scripts/release.cjs --status               # print saved progress, change nothing
//   node scripts/release.cjs --reset                # forget saved progress, run every step again
//   node scripts/release.cjs --skip-upload          # package + tag + push, no GitHub Release
//   node scripts/release.cjs --skip-push            # package + local tag only
//   node scripts/release.cjs --skip-build           # reuse existing dist/ and installer
//   node scripts/release.cjs --yes                  # no confirmation prompts
//   node scripts/release.cjs --edit                 # edit the tag message (also re-tags + re-releases)
//   node scripts/release.cjs --notes-file notes.md  # use your own tag message
//   node scripts/release.cjs --help
//
// Long steps (typecheck, build, package, push, upload) stream their output and keep a
// one-line elapsed-time heartbeat; the installer upload shows a progress bar with ETA.
//
// Auth: GITHUB_TOKEN / GH_TOKEN, else the token stored by git credential helper
// (Git for Windows "wincred"/manager). The token is never printed or written anywhere.
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const notesLib = require('./release-notes.cjs')
const store = require('./release-state.cjs')
const proc = require('./release-proc.cjs')

const root = path.resolve(__dirname, '..')
const API = 'https://api.github.com'
const OWNER = 'LijunTong'
const REPO = 'Something'
const REQUIRED_BRANCH = 'master'
const TOTAL_STEPS = store.STEPS.length

const argv = process.argv.slice(2)
const flag = (name) => argv.indexOf('--' + name) >= 0
const value = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
}
const OPT = {
  skipUpload: flag('skip-upload'),
  skipPush: flag('skip-push'),
  skipBuild: flag('skip-build'),
  yes: flag('yes'),
  edit: flag('edit'),
  status: flag('status'),
  reset: flag('reset'),
  help: flag('help') || flag('h'),
  notesFile: value('notes-file')
}

const runStart = Date.now()
let state = null
let activeStep = ''
let moveTag = false
let resolvedNotes = ''
const stepStart = {}

/* ---------------- shared helpers ---------------- */

function log(tag, msg) {
  console.log('[' + tag + '] ' + msg)
}

function warn(msg) {
  console.log('[warn] ' + msg)
}

function fmtTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

function statOrNull(file) {
  try {
    return fs.statSync(file)
  } catch (e) {
    return null
  }
}

function persist() {
  if (!state) return
  try {
    store.save(root, state)
  } catch (e) {
    warn('cannot save progress (' + store.stateFile(root, state.version) + '): ' + (e && e.message ? e.message : String(e)))
  }
}

function stepNo(key) {
  return store.STEP_KEYS.indexOf(key) + 1
}

function beginStep(key, detail) {
  activeStep = key
  stepStart[key] = Date.now()
  if (state && state.steps[key]) {
    state.steps[key].status = 'running'
    state.steps[key].startedAt = new Date().toISOString()
    delete state.steps[key].error
  }
  persist()
  console.log('')
  console.log('==> [' + stepNo(key) + '/' + TOTAL_STEPS + '] ' + key + (detail ? '  ' + detail : ''))
}

function finishStep(key, extra) {
  const ms = Date.now() - (stepStart[key] || Date.now())
  activeStep = ''
  if (state && state.steps[key]) {
    state.steps[key].status = 'done'
    state.steps[key].ms = ms
    state.steps[key].at = new Date().toISOString()
    state.steps[key].error = ''
  }
  persist()
  console.log('<== [' + stepNo(key) + '/' + TOTAL_STEPS + '] ' + key + '  ' + proc.humanMs(ms) + (extra ? '  ' + extra : ''))
}

function noteStep(key, why) {
  console.log('[skip] [' + stepNo(key) + '/' + TOTAL_STEPS + '] ' + key + '  ' + why)
}

function fail(msg) {
  if (state) {
    if (activeStep && state.steps[activeStep]) {
      state.steps[activeStep].status = 'failed'
      state.steps[activeStep].error = msg
    }
    state.status = 'failed'
    state.stoppedAt = activeStep || state.stoppedAt || 'preflight'
    state.error = msg
    persist()
  }
  console.error('')
  console.error('[release] FAILED: ' + msg)
  if (state) {
    const kept = store.doneKeys(state)
    const next = store.nextKey(state)
    if (kept.length) console.error('[release] kept: ' + kept.join(', '))
    console.error('[release] re-run "npm run release" to continue' + (next ? ' from "' + next + '"' : '') + '; done steps are not repeated')
    console.error('[release] progress file: ' + store.stateFile(root, state.version))
  }
  process.exit(1)
}

// 后台命令的当前步骤在失败提示里要能说出来；Ctrl+C 也先把进度落盘再退出。
function onSignal(sig) {
  if (state) {
    if (activeStep && state.steps[activeStep]) state.steps[activeStep].status = 'interrupted'
    state.status = 'interrupted'
    state.stoppedAt = activeStep || state.stoppedAt || 'preflight'
    state.error = 'interrupted by ' + sig
    persist()
  }
  console.log('')
  console.log('[release] interrupted (' + sig + '); re-run "npm run release" to continue from "' + (activeStep || 'preflight') + '"')
  process.exit(130)
}

function ask(question) {
  if (OPT.yes) return true
  process.stdout.write(question + ' [y/N] ')
  const buf = Buffer.alloc(64)
  let n = 0
  try {
    n = fs.readSync(0, buf, 0, 64, null)
  } catch (e) {
    return false
  }
  const answer = buf.slice(0, n).toString('utf8').trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

// 短命令同步执行并抓输出（git、preflight 用）；长命令走 proc.runStream 实时转发。
function run(cmd, args, opts) {
  const o = opts || {}
  const stdio = o.capture === false ? 'inherit' : o.input != null ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
  const inv = proc.invocation(cmd, args)
  const spawnOpts = { cwd: o.cwd || root, encoding: 'utf8', stdio: stdio, env: Object.assign({}, process.env, o.env || {}) }
  if (o.input != null) spawnOpts.input = o.input
  const res = spawnSync(inv.file, inv.argv, spawnOpts)
  const out = (res.stdout || '') + (res.stderr || '')
  if (res.error) fail(cmd + ' -> ' + res.error.message)
  if (res.status !== 0) {
    if (o.allowFail) return { ok: false, out: out, status: res.status }
    console.error(out)
    fail(cmd + ' ' + args.join(' ') + ' exited with ' + res.status)
  }
  return { ok: true, out: (res.stdout || '').trim(), status: 0 }
}

function git(args, opts) {
  return run('git', args, opts)
}

function printUsage() {
  const lines = [
    'Usage: node scripts/release.cjs [options]',
    '',
    '  --status              show saved progress for the current package.json version',
    '  --reset               discard saved progress and run every step again',
    '  --skip-build          reuse dist/ and the existing installer (no typecheck/build/package)',
    '  --skip-push           package + local tag only',
    '  --skip-upload         do not create/upload the GitHub Release',
    '  --yes                 assume yes for confirmation prompts',
    '  --edit                open the tag message in $EDITOR (re-tags and re-releases)',
    '  --notes-file <file>   use your own tag message file',
    '  --help                show this help',
    '',
    'Progress is saved per version in release/.release-state/v<version>.json; a rerun',
    'continues from the first step that is not done yet.'
  ]
  console.log(lines.join('\n'))
}

/* ---------------- 1. preflight ---------------- */

if (OPT.help) {
  printUsage()
  process.exit(0)
}

const pkgPath = path.join(root, 'package.json')
if (!fs.existsSync(pkgPath)) fail('package.json not found in ' + root)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const version = String(pkg.version || '').trim()
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('package.json version is not semver: "' + version + '"')
}
const tag = 'v' + version
const installer = path.join(root, 'release', 'Something-Setup-' + version + '.exe')
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// better-sqlite3 是编译产物，打包/校验都按这个相对路径找。
const nativeRel = path.join('node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
const nativeAbs = path.join(root, nativeRel)

const topLevel = git(['rev-parse', '--show-toplevel']).out
if (path.resolve(topLevel) !== path.resolve(root)) {
  fail('script must live inside the repo it releases (repo root: ' + topLevel + ')')
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
const headSha = git(['rev-parse', 'HEAD']).out
const headTime = Number(git(['show', '-s', '--format=%ct', headSha]).out || 0) * 1000

// 只有改到打包输入的提交才需要重新构建：只动文档、发布脚本或 README 的提交不该
// 把已经打好的安装包判成过期，否则「改完脚本再发布」每次都得重打三分钟。
const BUILD_INPUTS = ['src', 'electron', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json']
const srcRef = git(['log', '-1', '--format=%ct', '--'].concat(BUILD_INPUTS), { allowFail: true })
const srcTime = srcRef.ok && srcRef.out ? Number(srcRef.out) * 1000 : headTime

const distIndex = path.join(root, 'dist', 'index.html')
const distStat = statOrNull(distIndex)
const installerStat = statOrNull(installer)
const MIN_INSTALLER_SIZE = 1024 * 1024
const installerUsable = Boolean(installerStat && installerStat.size >= MIN_INSTALLER_SIZE)
// 产物比最后一次改打包输入的提交还新，说明它就是这份源码打出来的。留 1s 容忍时间粒度。
const distFresh = Boolean(distStat && srcTime > 0 && distStat.mtimeMs + 1000 >= srcTime)
const installerFresh = Boolean(installerUsable && srcTime > 0 && installerStat.mtimeMs + 1000 >= srcTime)

const tagRef = git(['rev-parse', '-q', '--verify', 'refs/tags/' + tag + '^{}'], { allowFail: true })
const tagObj = git(['rev-parse', '-q', '--verify', 'refs/tags/' + tag], { allowFail: true })
const tagAtHead = tagRef.ok && tagRef.out === headSha

function installerSizeMb() {
  const s = statOrNull(installer)
  return s ? (s.size / 1024 / 1024).toFixed(1) : '?'
}

function artifactSummary() {
  const bits = []
  if (installerUsable) {
    bits.push('installer ' + installerSizeMb() + ' MB @ ' + fmtTime(installerStat.mtimeMs) + (installerFresh ? ' (newer than the last source change)' : ' (OLDER than the last source change)'))
  } else {
    bits.push('installer missing')
  }
  if (distStat) {
    bits.push('dist/ @ ' + fmtTime(distStat.mtimeMs) + (distFresh ? ' (newer than the last source change)' : ' (OLDER than the last source change)'))
  } else {
    bits.push('dist/ missing')
  }
  if (srcTime) bits.push('source @ ' + fmtTime(srcTime))
  bits.push('tag ' + tag + (tagAtHead ? ' -> HEAD' : tagObj.ok ? ' -> other commit' : ' missing'))
  return bits.join('  |  ')
}

/* ---------------- 2. saved progress ---------------- */

if (OPT.reset && !OPT.status) {
  store.clear(root, version)
  log('state', '--reset: saved progress discarded')
}

const loaded = store.load(root, version)
const stale = Boolean(loaded && loaded.headSha !== headSha)
state = loaded && !stale
  ? loaded
  : store.create({ version: version, tag: tag, headSha: headSha, branch: branch })

// 上一轮留在磁盘上的产物（安装包 / dist / 标签）直接认领为已完成，避免重打一遍。
function adoptReusable() {
  if (state.steps.build.status !== 'done' && distFresh) {
    state.steps.build = { status: 'done', reused: true, note: 'reused dist/ (' + fmtTime(distStat.mtimeMs) + ')' }
  }
  // 安装包只在 dist/ 也仍是当前提交的时候才沿用，否则装出来的内容和源码不一致。
  if (state.steps.package.status !== 'done' && installerFresh && distFresh) {
    state.steps.package = { status: 'done', reused: true, note: 'reused installer ' + installerSizeMb() + ' MB (' + fmtTime(installerStat.mtimeMs) + ')' }
  }
  if (state.steps.tag.status !== 'done' && tagAtHead && !OPT.edit && !OPT.notesFile) {
    state.steps.tag = { status: 'done', reused: true, note: tag + ' already at HEAD' }
  }
  // 记录为 done、但产物已经被删掉/挪走的步骤，重新排队。
  if (state.steps.build.status === 'done' && !distStat) {
    state.steps.build = { status: 'pending', note: 'dist/ is missing' }
  }
  if (state.steps.package.status === 'done' && !installerUsable) {
    state.steps.package = { status: 'pending', note: 'installer is missing' }
  }
  if (state.steps.tag.status === 'done' && !tagAtHead) {
    state.steps.tag = { status: 'pending', note: 'tag no longer points at HEAD' }
  }
  // dist/ 沿用时说明这份源码当时已经通过检查，typecheck 不再重复跑一遍。
  if (state.steps.build.status === 'done' && state.steps.build.reused && state.steps.typecheck.status !== 'done') {
    state.steps.typecheck = { status: 'done', reused: true, note: 'implied by the reused build artifacts' }
  }
}
adoptReusable()

function renderStatus(shown, isStale) {
  console.log('')
  log('status', 'v' + version + '  branch=' + branch + '  HEAD=' + headSha.slice(0, 7) + (headTime ? '  committed ' + fmtTime(headTime) : ''))
  log('status', 'artifacts: ' + artifactSummary())
  // 没有存档时也把「产物已经满足哪几步」画出来，否则用户看不出重跑会跳过什么。
  const source = shown || state
  log('status', shown
    ? 'saved run: ' + (shown.status || 'unknown') + (shown.updatedAt ? '  updated ' + fmtTime(new Date(shown.updatedAt).getTime()) : '')
    : 'no saved progress for ' + tag + '; below is what a run would do (steps already covered by the artifacts above are marked reused)')
  for (const key of store.STEP_KEYS) {
    const s = source.steps[key] || { status: 'pending' }
    const tail = s.note ? '  ' + s.note : ''
    console.log('[status] ' + ('[' + stepNo(key) + '/' + TOTAL_STEPS + ']').padEnd(6) + ' ' + key.padEnd(11) + String(s.status || 'pending').padEnd(9) + (s.ms ? proc.humanMs(s.ms) : '') + tail)
  }
  if (!shown) {
    const derived = store.STEP_KEYS.filter((key) => (source.steps[key] || {}).status !== 'done')
    log('status', derived.length ? 'next: npm run release -> starts at "' + derived[0] + '"' : 'next: nothing pending; --reset runs every step again')
    return
  }
  if (isStale) log('status', 'WARNING: this progress belongs to ' + shown.headSha.slice(0, 7) + '; a run on HEAD discards it and rebuilds')
  if (shown.stoppedAt) log('status', 'stopped at: ' + shown.stoppedAt)
  if (shown.error) log('status', 'last error: ' + shown.error)
  if (shown.releaseUrl) log('status', 'release: ' + shown.releaseUrl)
  const pending = store.STEP_KEYS.filter((key) => (shown.steps[key] || {}).status !== 'done')
  log('status', pending.length ? 'next: npm run release -> continues from "' + pending[0] + '"' : 'next: nothing pending; --reset runs every step again')
}

if (OPT.status) {
  renderStatus(loaded, stale)
  process.exit(0)
}

if (loaded && !stale && state.status === 'done' && !OPT.reset && !OPT.edit && !OPT.notesFile) {
  renderStatus(loaded, false)
  log('state', 'v' + version + ' was already released; nothing to do (--reset reruns every step, --edit updates the message)')
  process.exit(0)
}

/* ---------------- 3. plan + guards ---------------- */

function planSteps() {
  if (OPT.skipBuild) {
    if (!installerUsable) {
      fail('installer missing or too small: ' + installer + ' (--skip-build reuses it, it does not build one)')
    }
    state.steps.build = { status: 'done', reused: true, note: 'waived by --skip-build' }
    state.steps.package = { status: 'done', reused: true, note: 'waived by --skip-build; installer ' + installerSizeMb() + ' MB' }
  }
  // 消息改了：标签内容变了，推送和 Release 都要跟着重做。
  if (OPT.edit || OPT.notesFile) {
    for (const key of ['tag', 'pushTag', 'release']) {
      if (state.steps[key].status === 'done') state.steps[key] = { status: 'pending', note: 'message changed' }
    }
    state.status = 'running'
  }
}
planSteps()

if (branch !== REQUIRED_BRANCH) {
  fail('releases are only allowed on "' + REQUIRED_BRANCH + '", current branch is "' + branch + '". Run: git checkout ' + REQUIRED_BRANCH)
}

// 某些工具会在仓库根留下一个名为 "CON" 的 Windows 保留设备名文件，
// 它会以未跟踪文件身份挡住 clean-tree 检查，所以先清掉再看工作区。
try {
  const stray = path.join(root, 'CON')
  if (fs.lstatSync(stray).isFile()) fs.unlinkSync(stray)
} catch (e) {
  /* 不存在，或者是控制台设备本身 */
}

const dirty = git(['status', '--porcelain']).out
if (dirty) {
  console.error(dirty)
  fail('working tree is not clean; commit or stash before releasing')
}

const origin = git(['remote', 'get-url', 'origin'], { allowFail: true })
if (!origin.ok) fail('git remote "origin" is missing')
const expectedOrigin = 'github.com/' + OWNER + '/' + REPO
if (origin.out.replace(/\\/g, '/').indexOf(expectedOrigin) < 0) {
  fail('remote "origin" points to ' + origin.out + ', expected ' + expectedOrigin)
}

if (tagRef.ok) {
  if (tagAtHead) {
    log('preflight', 'tag ' + tag + ' already points at HEAD')
  } else {
    moveTag = true
    log('preflight', 'tag ' + tag + ' points at ' + tagRef.out.slice(0, 7) + ', HEAD is ' + headSha.slice(0, 7))
    if (!ask('Move tag ' + tag + ' to HEAD?')) fail('aborted: existing tag ' + tag + ' was not moved')
  }
}

if (stale) {
  log('state', 'discarding progress from ' + loaded.headSha.slice(0, 7) + ' (HEAD is now ' + headSha.slice(0, 7) + '); artifacts will be rebuilt')
}

persist()

function printPlan() {
  console.log('')
  log('plan', 'v' + version + '  branch=' + branch + '  HEAD=' + headSha.slice(0, 7) + '  progress=' + store.stateFile(root, version))
  for (const key of store.STEP_KEYS) {
    const s = state.steps[key] || { status: 'pending' }
    const tail = s.note ? '  ' + s.note : ''
    console.log('[plan] ' + ('[' + stepNo(key) + '/' + TOTAL_STEPS + ']').padEnd(6) + ' ' + key.padEnd(11) + String(s.status || 'pending').padEnd(9) + tail)
  }
  const done = store.doneKeys(state)
  const next = store.nextKey(state)
  if (done.length && next) log('plan', 'resuming: done=' + done.join(',') + '  next=' + next)
  else if (!done.length) log('plan', 'starting from the first step')
}
printPlan()

process.once('SIGINT', function () { onSignal('SIGINT') })
process.once('SIGTERM', function () { onSignal('SIGTERM') })

/* ---------------- 4. steps ---------------- */
// ===== steps 4a: native module, typecheck, build, package =====

const electronVersion = String((pkg.devDependencies && pkg.devDependencies.electron) || '').replace(/^[^\d]*/, '')
const notesFile = path.join(os.tmpdir(), 'something-release-notes-' + tag + '.txt')
const unpackedRoot = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar.unpacked')
const packagedNative = path.join(unpackedRoot, nativeRel)
const interactive = Boolean(process.stdin.isTTY) && !OPT.yes
let notes = ''

function ensureNativeModule() {
  if (fs.existsSync(nativeAbs)) return
  warn('better-sqlite3 binary missing at ' + nativeRel)
  if (!electronVersion) fail('cannot tell the Electron version from package.json devDependencies.electron')
  log('native', 'rebuilding better-sqlite3 for Electron ' + electronVersion + ' (x64)')
  const prebuild = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install')
  if (!fs.existsSync(prebuild)) fail('prebuild-install is missing; run npm install first')
  const res = run(prebuild, ['-r', 'electron', '-t', electronVersion, '--arch', 'x64'])
  if (!fs.existsSync(nativeAbs)) fail('better-sqlite3 rebuild finished but ' + nativeRel + ' is still missing' + (res.out ? '\n' + res.out : ''))
  log('native', 'native module ready')
}

// The app loads better-sqlite3 from asar.unpacked; a missing binary produces an
// installer that crashes on first launch, which is worse than no release at all.
function verifyNativeBundled() {
  if (!fs.existsSync(packagedNative)) {
    fail('installer was built without ' + path.join('app.asar.unpacked', nativeRel) + '; the app would fail to start')
  }
}

async function stepTypecheck() {
  const s = state.steps.typecheck
  if (s.status === 'done') {
    noteStep('typecheck', s.note || 'already passed')
    return
  }
  // dist/ 与安装包若已从上一轮沿用，说明源码当时已经通过检查，不再重复跑。
  if (state.steps.build.status === 'done' && state.steps.build.reused) {
    state.steps.typecheck = { status: 'done', reused: true, note: 'implied by the reused build artifacts' }
    persist()
    noteStep('typecheck', 'skipped: build artifacts were reused from a previous run')
    return
  }
  beginStep('typecheck')
  const r = await proc.runStream(npxCmd, ['vue-tsc', '--noEmit'], { label: 'typecheck: vue-tsc --noEmit' })
  if (r.status !== 0) fail('typecheck failed (exit ' + r.status + ')')
  finishStep('typecheck')
}

async function stepBuild() {
  const s = state.steps.build
  if (s.status === 'done') {
    noteStep('build', s.note || 'already built')
    return
  }
  beginStep('build')
  const r = await proc.runStream(npmCmd, ['run', 'build'], { label: 'vite build' })
  if (r.status !== 0) fail('build failed (exit ' + r.status + '); dist/ was not updated')
  const d = statOrNull(distIndex)
  if (!d) fail('build reported success but dist/index.html is missing')
  finishStep('build', 'dist/ ready (' + fmtTime(d.mtimeMs) + ')')
}

async function stepPackage() {
  const s = state.steps.package
  if (s.status === 'done') {
    noteStep('package', s.note || ('installer already built: ' + installerSizeMb() + ' MB'))
    return
  }
  beginStep('package', 'electron-builder --win nsis (takes a few minutes)')
  ensureNativeModule()
  const r = await proc.runStream(
    npxCmd,
    ['electron-builder', '--win', 'nsis', '--publish', 'never', '--config.npmRebuild=false'],
    { label: 'electron-builder packaging' }
  )
  if (r.status !== 0) fail('electron-builder failed (exit ' + r.status + ')')
  if (!installerUsable) fail('electron-builder finished but ' + installer + ' is missing or smaller than 1 MB')
  verifyNativeBundled()
  finishStep('package', 'installer ' + installerSizeMb() + ' MB')
}

// ===== steps 4b: release message + local tag =====

function readTextFile(file, what) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
    if (!text) fail(what + ' is empty: ' + file)
    return text
  } catch (e) {
    fail('cannot read ' + what + ': ' + (e && e.message ? e.message : String(e)))
  }
  return ''
}

// 已经打在 tag 上的消息是「已经发布出去的事实」，重跑时优先沿用它，
// 这样旧脚本里手工改过的 msg 不会在续跑时被重新生成的文本覆盖。
function existingTagMessage() {
  if (!tagObj.ok) return ''
  const r = git(['for-each-ref', '--format=%(contents)', 'refs/tags/' + tag], { allowFail: true })
  return r.ok ? String(r.out || '').trim() : ''
}

function localTagObjectSha() {
  const r = git(['rev-parse', '-q', '--verify', 'refs/tags/' + tag], { allowFail: true })
  return r.ok ? r.out : ''
}

function resolveNotes() {
  if (notes) return notes
  if (OPT.notesFile) {
    notes = readTextFile(path.resolve(root, OPT.notesFile), '--notes-file')
    state.notes = notes
    persist()
    log('notes', 'using --notes-file ' + OPT.notesFile)
    return notes
  }
  const existing = existingTagMessage()
  if (existing) {
    notes = existing
    state.notes = existing
    persist()
    log('notes', 'reusing the message already on ' + tag + ' (' + existing.split('\n').length + ' lines)')
    return notes
  }
  if (state.notes) {
    notes = state.notes
    log('notes', 'reusing the message confirmed in a previous run')
    return notes
  }
  let built = ''
  try {
    built = notesLib.build({ root: root, version: version, tag: tag })
  } catch (e) {
    fail('cannot build release notes: ' + (e && e.message ? e.message : String(e)))
  }
  notes = built
  state.notes = built
  persist()
  log('notes', 'generated from the commits since the previous tag')
  return notes
}

function editNotes(seed) {
  fs.writeFileSync(notesFile, seed + '\n', 'utf8')
  const editor = process.env.VISUAL || process.env.EDITOR || ''
  const res = editor
    ? spawnSync(editor + ' "' + notesFile + '"', { cwd: root, stdio: 'inherit', shell: true })
    : spawnSync(process.platform === 'win32' ? 'notepad.exe' : 'vi', [notesFile], { cwd: root, stdio: 'inherit' })
  if (res.error) fail('cannot launch the editor (' + res.error.message + '); edit ' + notesFile + ' by hand')
  return readTextFile(notesFile, 'edited tag message')
}

function showNotes(text) {
  for (const line of text.split('\n')) console.log('   ' + line)
}

async function stepTag() {
  const s = state.steps.tag
  if (s.status === 'done') {
    noteStep('tag', s.note || (tag + ' already points at HEAD'))
    return
  }
  beginStep('tag', tag + ' -> ' + headSha.slice(0, 7))

  const before = localTagObjectSha()
  notes = resolveNotes()

  let wantEdit = OPT.edit
  if (!wantEdit && interactive) {
    wantEdit = ask('Edit the tag message before tagging? [' + notesFile + ']')
  }
  if (wantEdit) {
    for (;;) {
      notes = editNotes(notes)
      state.notes = notes
      persist()
      log('tag', 'message:')
      showNotes(notes)
      if (!interactive || !ask('Edit it again?')) break
    }
  } else {
    log('tag', 'message:')
    showNotes(notes)
  }

  const current = existingTagMessage()
  // 内容和位置都没变就别动标签：重打一次会换掉 tag 对象 sha，等于让远端标签和
  // Release 全部失效，白白多做一轮。
  if (current && current === notes && tagAtHead) {
    finishStep('tag', tag + ' already carries this message at ' + headSha.slice(0, 7))
    return
  }
  if (current && current !== notes) {
    moveTag = true
    log('tag', 'message differs from the existing tag; it will be rewritten with -f')
  }

  // 消息走 stdin（-F -），空行和长行都能原样保留；-m 会把它们压成一段。
  if (tagObj.ok) {
    git(['tag', '-f', '-a', tag, '-F', '-'], { input: notes })
    log('tag', tag + ' rewritten at ' + headSha.slice(0, 7))
  } else {
    git(['tag', '-a', tag, '-F', '-'], { input: notes })
    log('tag', tag + ' created at ' + headSha.slice(0, 7))
  }

  const at = git(['rev-parse', '-q', '--verify', 'refs/tags/' + tag + '^{}'], { allowFail: true })
  if (!at.ok || at.out !== headSha) fail('tag ' + tag + ' does not point at HEAD after creation')
  const after = localTagObjectSha()
  if (after !== before) {
    // tag 内容变了：远端标签与 Release 都基于旧内容，必须重做。
    for (const key of ['pushTag', 'release']) {
      if (state.steps[key].status === 'done') {
        state.steps[key] = { status: 'pending', note: 'tag was rewritten' }
      }
    }
  }
  finishStep('tag')
}
// ===== steps 4c: push branch + tag =====

// 远端标签的 tag 对象 sha（不带 ^{}）：比较它才能发现「只改了消息」的标签，
// 只比 peeled commit 会把改过消息的标签误判成已推送。
function remoteTagObjectSha() {
  const res = git(['ls-remote', '--tags', 'origin', 'refs/tags/' + tag], { allowFail: true })
  if (!res.ok) return ''
  const plain = /^([0-9a-f]{40})\s+refs\/tags\/[^\s^]+$/m.exec(res.out)
  return plain ? plain[1] : ''
}

function remoteTagPeeledSha() {
  const res = git(['ls-remote', '--tags', 'origin', 'refs/tags/' + tag], { allowFail: true })
  if (!res.ok) return ''
  const peeled = /^([0-9a-f]{40})\s+refs\/tags\/[^\s]+\^\{\}$/m.exec(res.out)
  if (peeled) return peeled[1]
  const plain = /^([0-9a-f]{40})\s+refs\/tags\/[^\s^]+$/m.exec(res.out)
  return plain ? plain[1] : ''
}

// 推送可能因凭据缺失失败（后台运行没有终端也会失败）。匹配到认证问题时，
// 用 Windows 凭据管理器重试一次，和旧脚本行为一致。
async function pushStream(args, label) {
  const full = ['push', '--progress'].concat(args)
  let r = await proc.runStream('git', full, { label: label, mode: 'raw' })
  if (r.status !== 0 && /could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)/i.test(r.out || '')) {
    warn('push failed on credentials; retrying with the wincred helper')
    r = await proc.runStream('git', ['-c', 'credential.helper=wincred'].concat(full), { label: label + ' (credential retry)', mode: 'raw' })
  }
  return r
}

async function stepPushBranch() {
  const s = state.steps.pushBranch
  if (s.status === 'done') {
    noteStep('pushBranch', s.note || ('origin/' + branch + ' already up to date'))
    return
  }
  if (OPT.skipPush) {
    noteStep('pushBranch', 'skipped by --skip-push; stays pending')
    return
  }
  beginStep('pushBranch', 'origin ' + branch)
  const r = await pushStream([branch], 'git push origin ' + branch)
  if (r.status !== 0) fail('git push origin ' + branch + ' failed (exit ' + r.status + ')')
  finishStep('pushBranch')
}

// 返回 tag 是否已经在远端：Release 只能在标签推送成功之后创建。
async function stepPushTag() {
  const local = localTagObjectSha()
  const remote = remoteTagObjectSha()
  if (remote && remote === local) {
    if (state.steps.pushTag.status !== 'done') {
      state.steps.pushTag = { status: 'done', note: tag + ' already on origin' }
      persist()
    }
    noteStep('pushTag', tag + ' already on origin')
    return true
  }

  if (OPT.skipPush) {
    noteStep('pushTag', 'skipped by --skip-push; stays pending (git push origin ' + tag + ')')
    return false
  }
  if (!local) {
    fail('tag ' + tag + ' does not exist locally; re-run without --skip-build so it gets created')
  }

  const force = Boolean(remote) || moveTag
  if (remote) {
    log('pushTag', 'tag on origin is ' + remote.slice(0, 7) + ' but local tag is ' + local.slice(0, 7) + ' (message changed)')
  }
  const question = 'Push tag ' + tag + (force ? ' (force)' : '') + ' to origin?'
  if (state.steps.pushTag.status === 'done' && force) {
    log('pushTag', 'local tag changed since it was pushed; pushing again')
  } else if (!ask(question)) {
    state.steps.pushTag.note = 'declined at the prompt; tag kept local'
    persist()
    noteStep('pushTag', 'tag kept local. Push it later with: git push ' + (force ? '-f ' : '') + 'origin ' + tag)
    return false
  }

  beginStep('pushTag', 'origin ' + tag + (force ? ' (force)' : ''))
  const r = await pushStream(force ? ['-f', 'origin', tag] : ['origin', tag], 'git push ' + (force ? '-f ' : '') + 'origin ' + tag)
  if (r.status !== 0) fail('git push of tag ' + tag + ' failed (exit ' + r.status + ')')
  const now = remoteTagObjectSha()
  if (now !== localTagObjectSha()) {
    fail('tag push reported success but origin shows ' + (now ? now.slice(0, 7) : 'nothing') + ' for ' + tag)
  }
  finishStep('pushTag')
  return true
}

// ===== steps 4d: GitHub Release =====

let TOKEN = ''

// 显式 token 优先，否则复用 git 已经存好的 github.com 凭据（Git for Windows 的
// credential manager / wincred）。token 只留在内存里，不打印、不落盘。
function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  for (const extra of [[], ['-c', 'credential.helper=wincred']]) {
    const res = run('git', extra.concat(['credential', 'fill']), {
      allowFail: true,
      input: 'protocol=https\nhost=github.com\n\n'
    })
    const m = /^password=(.+)$/m.exec(res.out || '')
    if (m && m[1].trim()) return m[1].trim()
  }
  return ''
}

async function gh(pathname, init) {
  const opts = init || {}
  const headers = Object.assign({
    'user-agent': 'something-release',
    accept: 'application/vnd.github+json'
  }, opts.headers || {})
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN
  const res = await fetch(API + pathname, Object.assign({}, opts, { headers: headers }))
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch (e) {
    json = null
  }
  return { status: res.status, ok: res.ok, json: json, text: text }
}

function releaseBody(text) {
  const lines = [
    text,
    '',
    '- 安装包：Something-Setup-' + version + '.exe',
    '- 源码：' + headSha,
    '- Electron ' + ((pkg.devDependencies && pkg.devDependencies.electron) || '') + ' / Windows x64'
  ]
  return lines.join('\n')
}

async function publishRelease() {
  TOKEN = resolveToken()
  if (!TOKEN) {
    fail('no GitHub token: set GITHUB_TOKEN, or store a credential for github.com (git credential approve)')
  }
  notes = resolveNotes()
  const body = releaseBody(notes)

  log('release', 'look up release for ' + tag)
  const existing = await gh('/repos/' + OWNER + '/' + REPO + '/releases/tags/' + encodeURIComponent(tag))
  let rel = existing.status === 200 ? existing.json : null

  if (rel) {
    log('release', 'release exists (id=' + rel.id + '), updating metadata')
    const upd = await gh('/repos/' + OWNER + '/' + REPO + '/releases/' + rel.id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: tag, body: body, draft: false, prerelease: false })
    })
    if (!upd.ok) fail('update release failed: HTTP ' + upd.status + ' ' + upd.text.slice(0, 300))
    rel = upd.json
  } else if (existing.status === 404) {
    log('release', 'create release ' + tag)
    const created = await gh('/repos/' + OWNER + '/' + REPO + '/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: tag, body: body, draft: false, prerelease: false })
    })
    if (!created.ok) fail('create release failed: HTTP ' + created.status + ' ' + created.text.slice(0, 300))
    rel = created.json
  } else {
    fail('lookup release failed: HTTP ' + existing.status + ' ' + existing.text.slice(0, 300))
  }

  // 同名附件先删再传，避免留下重复的安装包。
  const assets = await gh('/repos/' + OWNER + '/' + REPO + '/releases/' + rel.id + '/assets')
  if (assets.ok && Array.isArray(assets.json)) {
    for (const a of assets.json) {
      if (a.name === path.basename(installer)) {
        log('release', 'delete old asset ' + a.name)
        const del = await gh('/repos/' + OWNER + '/' + REPO + '/releases/assets/' + a.id, { method: 'DELETE' })
        if (!del.ok && del.status !== 404) fail('delete asset failed: HTTP ' + del.status)
      }
    }
  }

  const base = path.basename(installer)
  const uploadUrl = String(rel.upload_url || '').replace(/\{.*\}$/, '') + '?name=' + encodeURIComponent(base)
  const size = fs.statSync(installer).size
  log('release', 'upload ' + base + ' (' + proc.humanBytes(size) + ')')
  const line = proc.statusLine()
  let up = null
  try {
    up = await proc.uploadFile(uploadUrl, installer, {
      authorization: 'Bearer ' + TOKEN,
      'user-agent': 'something-release',
      accept: 'application/vnd.github+json',
      'content-type': 'application/octet-stream'
    }, {
      onProgress: function (sent, total, startedAt) {
        line.update(proc.progressText(sent, total, startedAt))
      }
    })
  } catch (e) {
    line.clear()
    fail('upload failed (' + (e && e.message ? e.message : String(e)) + '); re-run to resume from the upload step')
  }
  line.clear()
  if (!up || (up.status !== 201 && up.status !== 200)) {
    fail('upload failed: HTTP ' + (up ? up.status : '?') + ' ' + (up ? String(up.text).slice(0, 300) : ''))
  }
  let asset = null
  try {
    asset = JSON.parse(up.text)
  } catch (e) {
    asset = null
  }
  log('release', 'asset uploaded: ' + (asset && asset.name ? asset.name : base) + ' (' + (asset && asset.size ? asset.size : size) + ' bytes)')
  return rel.html_url
}

async function stepRelease(tagPushed) {
  const s = state.steps.release
  if (s.status === 'done') {
    noteStep('release', 'already published' + (state.releaseUrl ? ' -> ' + state.releaseUrl : ''))
    return
  }
  if (OPT.skipUpload) {
    noteStep('release', 'skipped by --skip-upload; stays pending')
    return
  }
  if (!tagPushed) {
    noteStep('release', 'tag ' + tag + ' is not on origin yet; push it, then re-run to upload')
    return
  }
  beginStep('release', OWNER + '/' + REPO + ' ' + tag)
  const url = await publishRelease()
  state.releaseUrl = url
  persist()
  finishStep('release', 'release page: ' + url)
}

/* ---------------- 5. run ---------------- */

function finalize() {
  const pending = store.STEP_KEYS.filter((key) => (state.steps[key] || {}).status !== 'done')
  console.log('')
  if (!pending.length) {
    state.status = 'done'
    state.stoppedAt = ''
    state.error = ''
    persist()
    log('done', 'released ' + tag + ' in ' + proc.humanMs(Date.now() - runStart))
    if (state.releaseUrl) log('done', 'release page: ' + state.releaseUrl)
    log('done', 'progress file ' + store.stateFile(root, version) + ' (--reset reruns every step)')
    return 0
  }
  state.status = 'incomplete'
  state.stoppedAt = pending[0]
  persist()
  log('done', 'v' + version + ' is not fully released; pending: ' + pending.join(', '))
  log('done', 'next run continues from "' + pending[0] + '" (progress: ' + store.stateFile(root, version) + ')')
  return 0
}

async function main() {
  await stepTypecheck()
  await stepBuild()
  await stepPackage()
  await stepTag()
  await stepPushBranch()
  const tagPushed = await stepPushTag()
  await stepRelease(tagPushed)
  return finalize()
}

main().then(function (code) {
  process.exit(code || 0)
}).catch(function (e) {
  fail(e && e.message ? e.message : String(e))
})
