// scripts/release.cjs
// One-command release: typecheck -> build -> package -> tag -> push -> GitHub Release.
// Guards: must run on master, clean working tree, tag name = v + package.json version.
//
// Usage:
//   node scripts/release.cjs                # full release
//   node scripts/release.cjs --skip-upload  # package + tag + push, no GitHub Release
//   node scripts/release.cjs --skip-push    # package + local tag only
//   node scripts/release.cjs --skip-build   # reuse existing dist/ and installer
//   node scripts/release.cjs --yes          # no confirmation prompts
//
// Auth: GITHUB_TOKEN / GH_TOKEN, else the token stored by git credential helper
// (Git for Windows "wincred"/manager). The token is never printed or written anywhere.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const API = 'https://api.github.com'
const OWNER = 'LijunTong'
const REPO = 'Something'
const REQUIRED_BRANCH = 'master'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const OPT = {
  skipUpload: flag('skip-upload'),
  skipPush: flag('skip-push'),
  skipBuild: flag('skip-build'),
  yes: flag('yes')
}

function log(step, msg) {
  console.log('[' + step + '] ' + msg)
}

function fail(msg) {
  console.error('[release] FAILED: ' + msg)
  process.exit(1)
}

// Run a command in the repo root and return trimmed stdout; throws on non-zero exit.
function run(cmd, args, opts) {
  const o = opts || {}
  const stdio = o.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe']
  const env = { ...process.env, ...(o.env || {}) }
  // Windows ships npx/npm as .cmd shims; spawnSync cannot exec those directly
  // (EINVAL), so route them through cmd.exe.
  const res = process.platform === 'win32' && /\.cmd$/i.test(cmd)
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [cmd].concat(args).join(' ')], { cwd: root, encoding: 'utf8', stdio, env })
    : spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio, env })
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

// GitHub over HTTPS needs a stored credential. When credential.helper is not
// configured globally the first attempt fails with "could not read Username";
// retry once against the Windows credential store (wincred) before giving up.
function pushGit(args) {
  const first = git(args, { allowFail: true })
  if (first.ok) return
  if (/could not read Username|terminal prompts disabled|Authentication failed/i.test(first.out || '')) {
    log('push', 'credential helper missing in config; retrying with wincred')
    const retry = git(['-c', 'credential.helper=wincred'].concat(args), { allowFail: true })
    if (retry.ok) return
    console.error(retry.out)
    fail('git ' + args.join(' ') + ' failed even with wincred')
  }
  console.error(first.out)
  fail('git ' + args.join(' ') + ' exited with ' + first.status)
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

/* ---------------- 1. preflight ---------------- */

const pkgPath = path.join(root, 'package.json')
if (!fs.existsSync(pkgPath)) fail('package.json not found in ' + root)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const version = String(pkg.version || '').trim()
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail('package.json version is not semver: "' + version + '"')
}
const tag = 'v' + version
const installer = path.join(root, 'release', 'Something-Setup-' + version + '.exe')

const topLevel = git(['rev-parse', '--show-toplevel']).out
if (path.resolve(topLevel) !== path.resolve(root)) {
  fail('script must live inside the repo it releases (repo root: ' + topLevel + ')')
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
if (branch !== REQUIRED_BRANCH) {
  fail('releases are only allowed on "' + REQUIRED_BRANCH + '", current branch is "' + branch + '". Run: git checkout ' + REQUIRED_BRANCH)
}

const dirty = git(['status', '--porcelain']).out
if (dirty) {
  console.error(dirty)
  fail('working tree is not clean; commit or stash before releasing')
}

const origin = git(['remote', 'get-url', 'origin'], { allowFail: true })
if (!origin.ok) fail('git remote "origin" is missing')
const expectedOrigin = 'github.com/' + OWNER + '/' + REPO
if (!origin.out.replace(/\\/g, '/').includes(expectedOrigin)) {
  fail('remote "origin" points to ' + origin.out + ', expected ' + expectedOrigin)
}

// Keep the GitHub side and the local tag consistent: if the tag already exists on an
// older commit (re-releasing the same version), the script moves it after confirmation.
const headSha = git(['rev-parse', 'HEAD']).out
const tagRef = git(['rev-parse', '-q', '--verify', 'refs/tags/' + tag + '^{}'], { allowFail: true })
let moveTag = false
if (tagRef.ok) {
  if (tagRef.out === headSha) {
    log('preflight', 'tag ' + tag + ' already points at HEAD')
  } else {
    moveTag = true
    log('preflight', 'tag ' + tag + ' points at ' + tagRef.out.slice(0, 7) + ', HEAD is ' + headSha.slice(0, 7))
    if (!ask('Move tag ' + tag + ' to HEAD and force-push it?')) fail('aborted: existing tag ' + tag + ' was not moved')
  }
}

log('preflight', 'repo=' + root)
log('preflight', 'branch=' + branch + ' version=' + version + ' tag=' + tag + ' head=' + headSha.slice(0, 7))

/* ---------------- 2. typecheck + build ---------------- */

if (!OPT.skipBuild) {
  log('typecheck', 'npx vue-tsc --noEmit')
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vue-tsc', '--noEmit'])
  log('build', 'vite build')
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])
} else {
  log('build', 'skipped (--skip-build)')
}

/* ---------------- 3. package (NSIS installer) ---------------- */

// electron-builder normally rebuilds native modules before packaging. That rebuild
// needs Visual Studio (absent here) and exclusive access to better_sqlite3.node
// (EPERM when the app is running), while the installed binary already targets the
// bundled Electron. So the rebuild is disabled; run `npm run rebuild` after
// bumping the Electron version.
function packageInstaller() {
  const base = ['electron-builder', '--win', 'nsis', '--publish', 'never', '--config.npmRebuild=false']
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  log('package', 'electron-builder --win nsis (npmRebuild=false)')
  run(npx, base)
}

if (!OPT.skipBuild) {
  packageInstaller()
} else if (!fs.existsSync(installer)) {
  fail('installer missing: ' + installer)
}
if (!fs.existsSync(installer)) fail('installer was not produced: ' + installer)
const sizeMb = (fs.statSync(installer).size / 1024 / 1024).toFixed(1)
log('package', installer + ' (' + sizeMb + ' MB)')

/* ---------------- 4. tag ---------------- */

if (moveTag) {
  git(['tag', '-f', '-a', tag, '-m', 'v' + version])
  log('tag', tag + ' moved to ' + headSha.slice(0, 7))
} else if (!tagRef.ok) {
  git(['tag', '-a', tag, '-m', 'v' + version])
  log('tag', tag + ' created at ' + headSha.slice(0, 7))
}
log('tag', git(['describe', '--tags', '--always']).out)

/* ---------------- 5. push ---------------- */

if (OPT.skipPush) {
  log('push', 'skipped (--skip-push)')
} else {
  log('push', 'git push origin ' + branch)
  pushGit(['push', 'origin', branch])
  log('push', 'git push ' + (moveTag ? '-f ' : '') + 'origin ' + tag)
  pushGit(moveTag ? ['push', '-f', 'origin', tag] : ['push', 'origin', tag])
}

/* ---------------- 6. GitHub Release ---------------- */

// Prefer an explicit token, otherwise reuse the credential git already stores.
function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  // credential.helper is not always set in the repo/global config; ask wincred directly.
  for (const extra of [[], ['-c', 'credential.helper=wincred']]) {
    const res = spawnSync('git', extra.concat(['credential', 'fill']), {
      cwd: root,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8'
    })
    const m = /^password=(.+)$/m.exec(res.stdout || '')
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
  try { json = text ? JSON.parse(text) : null } catch (e) { json = null }
  return { status: res.status, ok: res.ok, json: json, text: text }
}

let TOKEN = ''

async function publishRelease() {
  TOKEN = resolveToken()
  if (!TOKEN) {
    fail('no GitHub token: set GITHUB_TOKEN, or store a credential for github.com (git credential approve)')
  }

  const body = [
    'Something v' + version,
    '',
    '- Installer: Something-Setup-' + version + '.exe',
    '- Source: ' + headSha,
    '- Electron ' + (pkg.devDependencies && pkg.devDependencies.electron ? pkg.devDependencies.electron : '') + ' / Windows x64'
  ].join('\n')

  log('release', 'look up release for ' + tag)
  const existing = await gh('/repos/' + OWNER + '/' + REPO + '/releases/tags/' + encodeURIComponent(tag), {})
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

  // Replace (not duplicate) a previously uploaded installer with the same file name.
  const assets = await gh('/repos/' + OWNER + '/' + REPO + '/releases/' + rel.id + '/assets', {})
  if (assets.ok && Array.isArray(assets.json)) {
    for (const a of assets.json) {
      if (a.name === path.basename(installer)) {
        log('release', 'delete old asset ' + a.name)
        const del = await gh('/repos/' + OWNER + '/' + REPO + '/releases/assets/' + a.id, { method: 'DELETE' })
        if (!del.ok && del.status !== 404) fail('delete asset failed: HTTP ' + del.status)
      }
    }
  }

  const uploadUrl = String(rel.upload_url || '').replace(/\{.*\}$/, '') + '?name=' + encodeURIComponent(path.basename(installer))
  log('release', 'upload ' + path.basename(installer) + ' (' + sizeMb + ' MB)')
  const bytes = fs.readFileSync(installer)
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + TOKEN,
      'user-agent': 'something-release',
      accept: 'application/vnd.github+json',
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length)
    },
    body: bytes
  })
  const upText = await up.text()
  if (!up.ok) fail('upload failed: HTTP ' + up.status + ' ' + upText.slice(0, 300))
  const asset = JSON.parse(upText)
  log('release', 'asset uploaded: ' + asset.name + ' (' + asset.size + ' bytes)')
  log('release', 'release page: ' + rel.html_url)
  return rel.html_url
}

if (OPT.skipUpload) {
  log('release', 'skipped (--skip-upload)')
} else {
  publishRelease().then(function (url) {
    log('done', 'released ' + tag + ' -> ' + url)
  }).catch(function (e) {
    fail(e && e.message ? e.message : String(e))
  })
}
