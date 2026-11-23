// scripts/release-notes.cjs
// Build the annotated-tag message: a readable list of what changed since the
// previous release tag, grouped by commit type.
//
// The same text feeds the local annotated tag and the GitHub Release body, so both
// stay in sync without hand-maintained notes.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SECTIONS = ['新增', '修复', '优化', '改动']
const MAX_ENTRIES = 60

// Conventional-commit prefixes decide the section; anything else (the wip(...)
// commits used for day-to-day snapshots) lands in 改动.
function classify(subject) {
  const s = String(subject || '').trim()
  if (/^feat(\([^)]*\))?\s*[:：]/i.test(s)) return '新增'
  if (/^fix(\([^)]*\))?\s*[:：]/i.test(s)) return '修复'
  if (/^(perf|refactor|opt|improve|style)(\([^)]*\))?\s*[:：]/i.test(s)) return '优化'
  return '改动'
}

function gitOut(root, args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (res.error) throw new Error('git ' + args.join(' ') + ': ' + res.error.message)
  if (res.status !== 0) {
    const msg = ((res.stderr || res.stdout) || '').trim()
    throw new Error('git ' + args.join(' ') + ' exited with ' + res.status + (msg ? ': ' + msg : ''))
  }
  return (res.stdout || '').trim()
}

function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function isLower(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i]
  }
  return false
}

// Highest existing version tag strictly below the one being released.
// --sort=-v:refname keeps v1.0.10 above v1.0.9, which plain lexical order does not.
function previousTag(root, tag) {
  const res = spawnSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: root, encoding: 'utf8' })
  if (res.error || res.status !== 0) return ''
  const tags = (res.stdout || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean)
  const older = tags.filter((t) => t !== tag && isLower(t, tag))
  return older.length ? older[0] : ''
}

function subjects(root, prev) {
  const args = ['log', '--no-merges', '--pretty=format:%s']
  if (prev) args.push(prev + '..HEAD')
  return gitOut(root, args).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

// notesFile: optional path (absolute or repo-relative) whose content replaces the
// generated list, for when the commit subjects are too terse to publish.
function build(opts) {
  const root = opts.root
  const version = String(opts.version || '').trim()
  const tag = opts.tag || 'v' + version
  const custom = String(opts.notesFile || '').trim()
  if (custom) {
    const p = path.resolve(root, custom)
    if (!fs.existsSync(p)) throw new Error('notes file not found: ' + p)
    const text = fs.readFileSync(p, 'utf8').trim()
    if (!text) throw new Error('notes file is empty: ' + p)
    return text
  }

  const prev = previousTag(root, tag)
  return compose({ tag: tag, prev: prev, subjects: subjects(root, prev) })
}

// Pure formatting step: (previous tag, commit subjects) -> tag message. Kept separate
// from git so it can be exercised without a repository.
function compose(opts) {
  const tag = opts.tag || ''
  const prev = opts.prev || ''
  // Drop the "wip(11-23 17:13): " snapshot prefix; the git log keeps the originals.
  const all = Array.isArray(opts.subjects)
    ? opts.subjects
      .filter((s) => String(s || '').trim())
      .map((s) => String(s).trim().replace(/^wip\(\d{2}-\d{2} \d{2}:\d{2}\):\s*/, ''))
    : []
  const shown = all.slice(0, MAX_ENTRIES)
  const groups = {}
  for (const name of SECTIONS) groups[name] = []
  for (const s of shown) groups[classify(s)].push(s)

  const lines = ['Something ' + tag, '']
  lines.push(prev
    ? '本次更新（自 ' + prev + ' 起，共 ' + all.length + ' 个提交）：'
    : '本次更新（首个版本，共 ' + all.length + ' 个提交）：')
  for (const name of SECTIONS) {
    if (!groups[name].length) continue
    lines.push('', '【' + name + '】')
    for (const s of groups[name]) lines.push('- ' + s)
  }
  if (!all.length) lines.push('', '- 仅版本号与打包调整')
  if (all.length > shown.length) {
    lines.push('', '（仅列出最近 ' + shown.length + ' 条，完整记录见 git log）')
  }
  return lines.join('\n')
}

module.exports = { build, compose, classify, previousTag }
