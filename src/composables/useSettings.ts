// 设置页共享状态：把所有面板读写集中在同一处，避免每个面板各自拉取 all()。
import { ref } from 'vue'
import { call, bridge, hasBridge, plain } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { useAppStore } from '@/stores/app'
import type { AllSettings } from '@/types/api'

const FALLBACK: AllSettings = {
  appearance: { theme: '浅色', accent: '#0f766e', font: '中', sidebarExpand: true },
  notify: { desktop: true, weather: true, schedule: true, todo: true, pomodoro: true, parcel: false, mail: true, dndStart: '22:00', dndEnd: '08:00', privacy: 'summary' },
  shortcuts: { search: 'Ctrl+K', newTodo: 'N', focus: 'F', viewSwitch: 'Ctrl+1-2' },
  window: { closeToTray: true, minimizeToTray: false, launchAtLogin: false },
  backup: { auto: true, path: '', freq: '每天', encrypted: false, passwordSet: false, lastAt: null, lastFile: null },
  weather: { source: 'qweather', host: '', geoHost: '', cacheMin: 5, refreshMin: 5, authType: 'jwt', offlineCache: true, alertPush: true, unit: 'C', apiKeySet: false, jwtSet: false, authMode: 'none' },
  feed: { defaultInterval: 360, keepContent: true },
  modules: { dashboard: true, weather: true, schedule: true, todo: true, pomodoro: true, feed: true, parcel: true, mail: true, notice: true }
}

const current = ref<AllSettings>(JSON.parse(JSON.stringify(FALLBACK)) as AllSettings)
const loaded = ref(false)
const saving = ref(false)

export function useSettings() {
  const store = useAppStore()

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
