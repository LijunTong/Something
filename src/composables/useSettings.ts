// 设置页共享状态：把所有面板读写集中在同一处，避免每个面板各自拉取 all()。
import { effectScope, ref, watch } from 'vue'
import { call, bridge, hasBridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useAppStore } from '@/stores/app'
import type { AllSettings } from '@/types/api'

const FALLBACK: AllSettings = {
  appearance: { theme: '浅色', accent: '#0f766e', font: '中', sidebarExpand: true },
  notify: { inApp: true, desktop: true, systemOnlyAway: true, weather: true, schedule: true, todo: true, pomodoro: true, parcel: false, mail: true, dndOn: false, dndStart: '22:00', dndEnd: '08:00', privacy: 'summary', sounds: { weather: '蜂鸣', schedule: '蜂鸣', todo: '蜂鸣', pomodoro: '蜂鸣', parcel: '蜂鸣', mail: '蜂鸣' } },
  shortcuts: { search: 'Ctrl+K', newTodo: 'N', focus: 'F' },
  window: { closeToTray: true, minimizeToTray: false, launchAtLogin: false },
  backup: { auto: true, path: '', freq: '每天', encrypted: false, keep: 10, passwordSet: false, lastAt: null, lastFile: null },
  weather: { source: 'qweather', host: '', geoHost: '', cacheMin: 5, refreshMin: 5, authType: 'jwt', offlineCache: true, alertPush: true, unit: 'C', apiKeySet: false, jwtSet: false, authMode: 'none' },
  feed: { defaultInterval: 360, keepContent: true },
  mail: { autoSyncMin: 15 },
  mcp: { enabled: false, port: null },
  parcel: { provider: 'manual', autoRefreshMin: 0, detectCompany: true },
  modules: { dashboard: true, weather: true, schedule: true, todo: true, pomodoro: true, feed: true, parcel: true, mail: true, notice: true },
  home: {
    locked: false,
    layout: [
      { key: 'weather', x: 0, y: 0, w: 1, h: 6 },
      { key: 'schedule', x: 1, y: 0, w: 2, h: 6 },
      { key: 'todo', x: 0, y: 6, w: 1, h: 6 },
      { key: 'pomodoro', x: 1, y: 6, w: 1, h: 7 },
      { key: 'parcel', x: 2, y: 6, w: 1, h: 6 },
      { key: 'feed', x: 0, y: 12, w: 1, h: 6 },
      { key: 'mail', x: 1, y: 13, w: 2, h: 6 },
      { key: 'notice', x: 0, y: 18, w: 1, h: 5 }
    ]
  }
}

const current = ref<AllSettings>(JSON.parse(JSON.stringify(FALLBACK)) as AllSettings)
const loaded = ref(false)
const saving = ref(false)

// Pinia 里的设置会在收到 settings 变更广播后整体替换（主进程迁移、另一处写入都会触发）。
// 这份 current 是各面板与服务共用的读源，必须跟着换，否则首页锁定态等会停在旧值。
let storeSync: { stop: () => void } | null = null
function ensureStoreSync(store: ReturnType<typeof useAppStore>) {
  if (storeSync) return
  const scope = effectScope(true)
  const stop = scope.run(() =>
    watch(
      () => store.settings,
      (next) => {
        if (!next || saving.value) return
        current.value = next
        loaded.value = true
      }
    )
  )
  storeSync = stop ? { stop } : null
}

export function useSettings() {
  const store = useAppStore()
  // 以 Pinia 里已加载的设置作为初值：首页卡片显隐等读取方不必依赖「先打开设置页」，
  // 否则重启后卡片会先按默认值全部显示，直到某处调用 load() 才收敛。
  if (!loaded.value && store.settings) {
    current.value = store.settings
    loaded.value = true
  }
  ensureStoreSync(store)

  async function load(force = false) {
    if (loaded.value && !force) return current.value
    if (!hasBridge()) {
      current.value = JSON.parse(JSON.stringify(FALLBACK)) as AllSettings
      loaded.value = true
      return current.value
    }
    try {
      const rows = await call(() => bridge().settings.all(), null as unknown as AllSettings)
      if (rows) current.value = rows
      loaded.value = true
    } catch (e) {
      log.exception('settings.load', e)
    }
    return current.value
  }

  /** 保存单个 section：先本地乐观更新，再由主进程回写结果覆盖。 */
  async function save<K extends keyof AllSettings>(section: K, value: AllSettings[K]) {
    current.value = { ...current.value, [section]: value }
    if (!hasBridge()) return current.value
    saving.value = true
    try {
      const patch = plain({ [section]: value }) as unknown as Partial<AllSettings>
      const rows = await call(() => bridge().settings.set(patch), current.value)
      if (rows) current.value = rows
      await store.refreshSettings()
    } catch (e) {
      log.exception('settings.save', e)
      throw e
    } finally {
      saving.value = false
    }
    return current.value
  }

  return { settings: current, loaded, saving, load, save, defaults: FALLBACK }
}
