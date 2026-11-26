// scripts/release-state.cjs
// 发布进度存档：每个版本一个 JSON（release/.release-state/v<version>.json）。
//
// release 是一条长链路：类型检查 -> 构建 -> 打包 -> 打标签 -> 推送 -> 上传 Release。
// 任何一步失败或 Ctrl+C 之后，下次执行读取同一版本的存档，只补没做完的步骤；
// 已确认的发布说明也一起存下来，避免重跑时被重新生成的内容覆盖。
//
// release/ 已在 .gitignore 内，存档不会弄脏工作区，也不会挡 release 的 clean-tree 检查。
const fs = require('node:fs')
const path = require('node:path')

// 顺序即执行顺序；status: pending / running / done / failed / interrupted
const STEPS = [
  { key: 'typecheck', title: 'vue-tsc --noEmit' },
  { key: 'build', title: 'vite build' },
  { key: 'package', title: 'electron-builder (NSIS)' },
  { key: 'tag', title: 'git tag' },
  { key: 'pushBranch', title: 'git push <branch>' },
  { key: 'pushTag', title: 'git push <tag>' },
  { key: 'release', title: 'GitHub Release' }
]

const STEP_KEYS = STEPS.map((s) => s.key)

function stateDir(root) {
  return path.join(root, 'release', '.release-state')
}

function stateFile(root, version) {
  return path.join(stateDir(root), 'v' + version + '.json')
}

function create(meta) {
  const steps = {}
  for (const step of STEPS) steps[step.key] = { status: 'pending' }
  const now = new Date().toISOString()
  return {
    version: meta.version,
    tag: meta.tag,
    headSha: meta.headSha,
    branch: meta.branch,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    stoppedAt: '',
    error: '',
    notes: '',
    releaseUrl: '',
    steps: steps
  }
}

// 存档按版本取；HEAD 变了由调用方判定（那边才知道「同一版本重新发布」是否合理）。
function load(root, version) {
  let raw = ''
  try {
    raw = fs.readFileSync(stateFile(root, version), 'utf8')
  } catch (e) {
    return null
  }
  try {
    const data = JSON.parse(raw)
    if (!data || data.version !== version || !data.steps) return null
    for (const key of STEP_KEYS) {
      if (!data.steps[key]) data.steps[key] = { status: 'pending' }
    }
    return data
  } catch (e) {
    // 存档坏了不阻塞发布，当作没有存档
    return null
  }
}

// 先写临时文件再 rename，避免半截 JSON（Windows 上 rename 会覆盖目标）。
function save(root, data) {
  const file = stateFile(root, data.version)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  data.updatedAt = new Date().toISOString()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

function clear(root, version) {
  try {
    fs.unlinkSync(stateFile(root, version))
  } catch (e) {
    /* 本来就没有 */
  }
}

function doneKeys(data) {
  return STEP_KEYS.filter((key) => data.steps[key] && data.steps[key].status === 'done')
}

// 下一个还要做的步骤：done 之外的（pending / failed / interrupted）都算。
function nextKey(data) {
  for (const key of STEP_KEYS) {
    if (!data.steps[key] || data.steps[key].status !== 'done') return key
  }
  return ''
}

module.exports = {
  STEPS,
  STEP_KEYS,
  stateDir,
  stateFile,
  create,
  load,
  save,
  clear,
  doneKeys,
  nextKey
}
