// 版本与更新检查。
// 版本号唯一来源：package.json 的 version。electron-builder 用它命名安装包，
// app.getVersion() 运行时读的也是它；GitHub tag 用 v + version（v1.0.0）保持一致。
const { app } = require('electron')
const logger = require('../log/logger.cjs')

// 发布仓库：检查更新只读这里的 latest release，不引入额外配置。
const OWNER_REPO = 'LijunTong/Something'
const REPO_URL = 'https://github.com/' + OWNER_REPO
const RELEASES_URL = REPO_URL + '/releases'
const LATEST_API = 'https://api.github.com/repos/' + OWNER_REPO + '/releases/latest'
const TIMEOUT_MS = 8000

// 版本号归一：'v1.0.0' / '1.0.0-beta.1' -> { nums, pre }；无法解析返回 null
function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' }
}

// latest 是否比 current 新：先比主次修订号，再按预发布标记（无标记的正式版更新）
function isNewer(latest, current) {
  const a = parseVersion(latest)
  if (!a) return false
  const b = parseVersion(current)
  if (!b) return true
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  }
  if (a.pre === b.pre) return false
  if (!a.pre) return true
  if (!b.pre) return false
  return a.pre > b.pre
}

// 读 GitHub 最新正式发布；超时或非 2xx 直接抛错，由 IPC 层转成结构化错误
async function fetchLatestRelease(current) {
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, TIMEOUT_MS)
  try {
    const res = await fetch(LATEST_API, {
      headers: {
        'user-agent': 'Something/' + current,
        accept: 'application/vnd.github+json'
      },
      signal: controller.signal,
      redirect: 'follow'
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error('HTTP_' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// 检查更新：返回当前版本、最新版本、是否有更新、发布页地址
async function check() {
  const current = app.getVersion()
  const out = {
    current: current,
    latest: null,
    hasUpdate: false,
    url: RELEASES_URL,
    repo: REPO_URL,
    name: null,
    publishedAt: null,
    notes: '',
    noRelease: false,
    checkedAt: Date.now()
  }
  try {
    const rel = await fetchLatestRelease(current)
    if (!rel) {
      out.noRelease = true
      return out
    }
    const tag = String(rel.tag_name || '')
    out.latest = tag.replace(/^v/i, '')
    out.name = rel.name || tag
    out.publishedAt = rel.published_at || null
    out.url = rel.html_url || RELEASES_URL
    out.notes = String(rel.body || '').slice(0, 800)
    out.hasUpdate = isNewer(out.latest, current)
    logger.info('update', 'check_ok', { current: current, latest: out.latest, hasUpdate: out.hasUpdate })
    return out
  } catch (e) {
    logger.warn('update', 'check_failed', { current: current, message: e && e.message })
    throw e
  }
}

module.exports = { check: check, current: function () { return app.getVersion() } }
