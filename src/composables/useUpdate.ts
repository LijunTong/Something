// 更新中心：检查 → 弹窗确认 → 下载（实时进度）→ 安装，外加「稍后提醒 / 忽略此版本」偏好。
//
// 状态放在模块作用域：设置页的按钮、全局弹窗、启动时的通知共用同一份，
// 避免「弹窗显示 40%、设置页显示 5%」这类各说各话。渲染层只读主进程推来的进度，
// 真正的下载与安装始终在主进程（electron/services/update.cjs）。
import { computed, reactive } from 'vue'
import { bridge, call, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { describeUpdateError } from '@/lib/update-error'
import { useAppStore } from '@/stores/app'
import type { UpdateCheckResult, UpdateProgressEvent } from '@/types/api'

export { describeUpdateError }

export type UpdatePhase = 'idle' | 'checking' | 'details' | 'downloading' | 'ready' | 'installing' | 'error'
type LastAction = 'check' | 'download' | 'install'

const state = reactive({
  /** 弹窗是否可见：设置页点「检查更新」与通知点「打开详情」都走这里 */
  visible: false,
  phase: 'idle' as UpdatePhase,
  info: null as UpdateCheckResult | null,
  percent: 0,
  received: 0,
  total: 0,
  /** 下载速度（字节/秒），按两次进度事件之间的增量估算 */
  speed: 0,
  error: '',
  errorCode: '',
  lastAction: 'check' as LastAction,
  initialized: false
})

let lastSample = { at: 0, received: 0 }
// 通知只在该版本第一次出现时弹；同一会话内不重复打扰
let announcedVersion = ''

export function updateState() {
  return state
}

/** 字节数转可读大小 */
export function formatBytes(n: number): string {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** 进度事件 → 弹窗状态：下载继续时弹窗关掉也不丢进度，重开直接接上 */
function applyProgress(p: UpdateProgressEvent | null) {
  if (!p) return
  const at = Date.now()
  if (p.state === 'downloading') {
    if (at - lastSample.at >= 300 && p.received >= lastSample.received) {
      state.speed = Math.round(((p.received - lastSample.received) * 1000) / Math.max(1, at - lastSample.at))
      lastSample = { at, received: p.received }
    }
    state.phase = 'downloading'
    state.percent = Math.max(0, Math.min(100, Number(p.percent) || 0))
    state.received = Number(p.received) || 0
    state.total = Number(p.total) || 0
    return
  }
  if (p.state === 'ready') {
    state.phase = 'ready'
    state.percent = 100
    state.total = Number(p.total) || state.total
    state.received = state.total || state.received
    state.speed = 0
    return
  }
  if (p.state === 'installing') {
    state.phase = 'installing'
    state.percent = 100
    return
  }
  if (p.state === 'error') {
    state.phase = 'error'
    state.error = p.message || '下载失败'
    state.errorCode = ''
    state.speed = 0
    return
  }
  state.phase = 'idle'
}

/** 订阅进度 + 读一次快照：下载可能在弹窗关闭后继续，重新打开时要能接上 */
export async function initUpdate() {
  if (state.initialized || !hasBridge()) return
  state.initialized = true
  const api = bridge()
  if (typeof api.onUpdateProgress === 'function') {
    api.onUpdateProgress((p: UpdateProgressEvent) => applyProgress(p))
  }
  try {
    const snap = await call(() => api.system.updateStatus(), null as UpdateProgressEvent | null)
    if (snap && snap.state !== 'idle') applyProgress(snap)
  } catch (e) {
    log.exception('update.status', e)
  }
}

/** 检查更新；interactive=true 时打开弹窗并显示「检查中」，false 用于启动时的静默检查 */
export async function checkUpdate(opts: { interactive?: boolean } = {}): Promise<UpdateCheckResult | null> {
  if (!hasBridge()) return null
  const interactive = !!opts.interactive
  if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing') {
    if (interactive) state.visible = true
    return null
  }
  state.lastAction = 'check'
  state.error = ''
  state.errorCode = ''
  if (interactive) {
    state.visible = true
    state.phase = 'checking'
  }
  try {
    const res = await call(() => bridge().system.checkUpdate(), null as UpdateCheckResult | null)
    state.info = res
    if (res?.hasUpdate) {
      state.phase = 'details'
    } else {
      // 手动点开时保留弹窗，让用户看到「已是最新」；启动时的静默检查本来就不显示弹窗
      state.phase = 'idle'
    }
    return res
  } catch (e) {
    const d = describeUpdateError(e)
    state.error = d.text
    state.errorCode = d.code
    state.phase = 'error'
    state.visible = interactive
    log.exception('update.check', e)
    return null
  }
}

/** 打开弹窗：有缓存结果直接显示，没有就重新检查一次 */
export function openUpdateDialog() {
  if (state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'installing') {
    state.visible = true
    return
  }
  state.visible = true
  if (state.info?.hasUpdate) {
    state.phase = 'details'
    state.error = ''
    return
  }
  void checkUpdate({ interactive: true })
}

/** 确认后才开始下载；返回值给调用方决定要不要弹消息 */
export async function startUpdateDownload(): Promise<'started' | 'noAsset' | 'latest' | 'failed'> {
  if (!hasBridge()) return 'failed'
  state.lastAction = 'download'
  state.error = ''
  state.errorCode = ''
  state.speed = 0
  state.percent = 0
  state.received = 0
  state.total = Number(state.info?.asset?.size) || 0
  state.phase = 'downloading'
  state.visible = true
  lastSample = { at: 0, received: 0 }
  try {
    const res = await call(() => bridge().system.downloadUpdate(), { started: false, hasUpdate: false, version: null })
    if (res.started) return 'started'
    if (res.noAsset) {
      state.phase = 'details'
      return 'noAsset'
    }
    state.phase = 'details'
    return 'latest'
  } catch (e) {
    const d = describeUpdateError(e)
    state.error = d.text
    state.errorCode = d.code
    state.phase = 'error'
    log.exception('update.download', e)
    return 'failed'
  }
}

/** 安装：安装程序由主进程分离启动，随后应用退出 */
export async function runUpdateInstall(): Promise<boolean> {
  if (!hasBridge()) return false
  state.lastAction = 'install'
  state.error = ''
  state.errorCode = ''
  state.phase = 'installing'
  try {
    await call(() => bridge().system.installUpdate(), false)
    return true
  } catch (e) {
    const d = describeUpdateError(e)
    state.error = d.text
    state.errorCode = d.code
    state.phase = 'error'
    log.exception('update.install', e)
    return false
  }
}

/** 失败后的重试：按上次卡住的环节回到那一步，而不是一律重新下载 */
export function retryUpdate() {
  if (state.lastAction === 'install') return runUpdateInstall()
  if (state.lastAction === 'check') return checkUpdate({ interactive: true })
  return startUpdateDownload()
}

function updatePrefs() {
  return useAppStore().settings?.update
}

export const updatePrefsSnapshot = computed(() => ({
  ignored: updatePrefs()?.ignored || '',
  snoozeUntil: Number(updatePrefs()?.snoozeUntil) || 0,
  autoCheck: updatePrefs()?.autoCheck !== false
}))

/** 该版本是否应该弹通知：被忽略过、或还在「稍后提醒」窗口内就不再打扰 */
export function shouldAnnounce(info: UpdateCheckResult | null): boolean {
  if (!info || !info.hasUpdate || !info.latest) return false
  if (announcedVersion === info.latest) return false
  const prefs = updatePrefsSnapshot.value
  if (prefs.ignored && prefs.ignored === info.latest) return false
  if (prefs.snoozeUntil && prefs.snoozeUntil > Date.now()) return false
  return true
}

export function markAnnounced(version: string | null) {
  announcedVersion = String(version || '')
}

/** 稍后提醒：默认 24 小时后再参与通知 */
export async function snoozeUpdate(hours = 24) {
  const store = useAppStore()
  const prefs = updatePrefs()
  await store.saveSettings({
    update: {
      ignored: prefs?.ignored || '',
      snoozeUntil: Date.now() + Math.max(1, hours) * 3600 * 1000,
      autoCheck: prefs?.autoCheck !== false
    }
  })
}

/** 忽略此版本：直到出现更新的版本才再提示 */
export async function ignoreUpdateVersion(version?: string | null) {
  const target = String(version || state.info?.latest || '')
  if (!target) return
  const store = useAppStore()
  const prefs = updatePrefs()
  await store.saveSettings({
    update: { ignored: target, snoozeUntil: 0, autoCheck: prefs?.autoCheck !== false }
  })
}

/** 恢复提醒：清掉忽略与暂缓 */
export async function restoreUpdateNotice() {
  const store = useAppStore()
  const prefs = updatePrefs()
  await store.saveSettings({ update: { ignored: '', snoozeUntil: 0, autoCheck: prefs?.autoCheck !== false } })
}

/** 打开 GitHub 发布页：没有安装包或开发模式下用它兜底 */
export async function openReleasePage(url?: string) {
  if (!hasBridge()) return
  const target = url || state.info?.url || 'https://github.com/LijunTong/Something/releases'
  try {
    await call(() => bridge().system.openExternal({ url: target }), false)
  } catch (e) {
    log.exception('update.openRelease', e)
  }
}
