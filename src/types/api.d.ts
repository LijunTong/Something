// 渲染进程与主进程 IPC 类型契约
export interface IpcResult<T> { ok: boolean; data?: T; error?: { code: string; message: string } }

export interface TodoListRow { id: string; name: string; color: string | null; sort: number; deletedAt?: number | null }
export interface TodoSubtask { id: string; todoId: string; title: string; done: boolean; sort: number }
export interface TodoRow {
  id: string; title: string; note: string | null; listId: string | null; listName: string | null
  priority: string; dueAt: number | null; remindAt: number | null; status: string; doneAt: number | null
  recurRule: string | null; sourceType: string | null; sourceRef: string | null
  focusSeconds: number; sort: number; createdAt: number; updatedAt: number
  labels: string[]; scheduleId: string | null
  subtasks: TodoSubtask[]
}
export interface TodoStats { pending: number; done: number; overdue: number; focusSeconds: number }
export interface AppearanceSetting { theme: '浅色' | '深色' | '跟随系统'; accent: string; font: '小' | '中' | '大'; sidebarExpand: boolean }
export interface NotifySetting {
  desktop: boolean; weather: boolean; schedule: boolean; todo: boolean
  pomodoro: boolean; parcel: boolean; mail: boolean
  dndStart: string; dndEnd: string; privacy: string
}
export interface ShortcutSetting { search: string; newTodo: string; focus: string; quickAdd: string; viewSwitch: string }
export interface BackupSetting {
  auto: boolean; path: string; freq: '每天' | '每周' | '每次退出'
  encrypted: boolean; passwordSet: boolean; lastAt: number | null; lastFile: string | null
}
export interface WeatherSetting {
  source: string; host: string; cacheMin: number
  offlineCache: boolean; alertPush: boolean; unit: 'C' | 'F'; apiKeySet: boolean
}
export interface FeedSetting { defaultInterval: number; keepContent: boolean }
export interface ModulesSetting {
  dashboard: boolean; weather: boolean; schedule: boolean; todo: boolean
  pomodoro: boolean; feed: boolean; parcel: boolean; mail: boolean
}
export interface AllSettings {
  appearance: AppearanceSetting; notify: NotifySetting; shortcuts: ShortcutSetting
  backup: BackupSetting; weather: WeatherSetting; feed: FeedSetting; modules: ModulesSetting
}
export interface StorageSegment { key: string; label: string; color: string; bytes: number }
export interface StorageUsage {
  dbFile: string | null; dbBytes: number; attachmentBytes: number; totalBytes: number
  segments: StorageSegment[]
  counts: { todo: number; schedule: number; mail: number; feed: number; parcel: number; city: number; notification: number }
  backupDir: string; lastBackupAt: number | null
}
export interface BackupFile { path: string; name: string; bytes: number; at: number; encrypted: boolean }
export interface BackupResult { path: string; name: string; bytes: number; encrypted: boolean; at: number }
export interface RestoreResult { restored: Record<string, number>; snapshot: string; at: number }
export interface ExportResult { path: string; name: string; bytes: number; kind: string }
export interface WeatherTestResult { ok: boolean; keySet: boolean; host: string; cacheMin: number; message: string }
export interface NotificationItem {
  id: string; module: string; level: string; title: string; body: string | null
  at: number; read: boolean; derived?: boolean
}

export interface Api {
  todo: {
    list(filter?: { status?: string; listId?: string; priority?: string; onlyPending?: boolean }): Promise<IpcResult<TodoRow[]>>
    get(id: string): Promise<IpcResult<TodoRow>>
    create(dto: Partial<TodoRow> & { title: string; subtasks?: { title: string; done?: boolean }[] }): Promise<IpcResult<TodoRow>>
    update(dto: Partial<TodoRow> & { id: string }): Promise<IpcResult<TodoRow>>
    toggle(id: string): Promise<IpcResult<TodoRow>>
    remove(id: string): Promise<IpcResult<boolean>>
    reorder(ids: string[]): Promise<IpcResult<boolean>>
    addSubtask(dto: { todoId: string; title: string }): Promise<IpcResult<TodoRow>>
    toggleSubtask(id: string): Promise<IpcResult<TodoRow>>
    lists(): Promise<IpcResult<TodoListRow[]>>
    stats(): Promise<IpcResult<TodoStats>>
  }
  schedule: ScheduleApi
  pomodoro: PomodoroApi
  weather: WeatherApi
  feed: FeedApi
  parcel: ParcelApi
  mail: MailApi
  settings: {
    all(): Promise<IpcResult<AllSettings>>
    get(key: keyof AllSettings): Promise<IpcResult<unknown>>
    set(patch: Partial<AllSettings>): Promise<IpcResult<AllSettings>>
    storage(): Promise<IpcResult<StorageUsage>>
    backup(dto?: { password?: string }): Promise<IpcResult<BackupResult>>
    backups(): Promise<IpcResult<{ dir: string; files: BackupFile[] }>>
    restore(dto: { path?: string; text?: string; password?: string }): Promise<IpcResult<RestoreResult>>
    exportData(dto: { kind: 'json' | 'ics' | 'opml' | 'eml' }): Promise<IpcResult<ExportResult>>
    clearCache(): Promise<IpcResult<{ weather: number; feed: number; mail: number }>>
    clearTrash(): Promise<IpcResult<{ todos: number; parcels: number }>>
    resetAll(): Promise<IpcResult<boolean>>
    setWeatherKey(dto: { key: string }): Promise<IpcResult<WeatherSetting>>
    testWeather(): Promise<IpcResult<WeatherTestResult>>
  }
  notification: {
    today(): Promise<IpcResult<NotificationItem[]>>
    unreadCount(): Promise<IpcResult<number>>
    markAllRead(): Promise<IpcResult<number>>
    create(dto: { module: string; level?: string; title: string; body?: string }): Promise<IpcResult<string>>
    remove(id: string): Promise<IpcResult<boolean>>
  }
  log: {
    write(dto: { level?: 'debug' | 'info' | 'warn' | 'error'; scope?: string; message: string; meta?: unknown }): Promise<IpcResult<boolean>>
    error(dto: { scope?: string; message: string; stack?: string; info?: string; location?: string; meta?: unknown }): Promise<IpcResult<boolean>>
    path(): Promise<IpcResult<{ file: string | null; dir: string | null }>>
    files(): Promise<IpcResult<string[]>>
  }
  system: {
    info(): Promise<IpcResult<{ version: string; userData: string; defaultUserData: string; dataSource: string; db: string }>>
    chooseDir(dto?: { title?: string; defaultPath?: string }): Promise<IpcResult<{ path: string | null }>>
    ping(): Promise<IpcResult<string>>
    openPath(p: string): Promise<IpcResult<boolean>>
    openExternal(dto: { url: string }): Promise<IpcResult<boolean>>
  }
  onDataChanged(cb: (payload: { domain: string; action: string; at: number }) => void): () => void
}
export interface ScheduleRow {
  id: string; title: string; startAt: number; endAt: number; allDay: boolean
  place: string | null; calendarId: string | null; calendarName: string | null; calendarColor: string | null
  remindMin: number; recurRule: string | null; note: string | null; status: string
  instanceAt?: number; occurrence?: boolean
}
export interface CalendarRow { id: string; name: string; color: string; visible: boolean; sort: number }
export interface ScheduleApi {
  range(dto?: { from?: number; to?: number }): Promise<IpcResult<ScheduleRow[]>>
  get(id: string): Promise<IpcResult<ScheduleRow>>
  create(dto: Partial<ScheduleRow> & { title: string; startAt: number; endAt: number }): Promise<IpcResult<ScheduleRow>>
  update(dto: Partial<ScheduleRow> & { id: string }): Promise<IpcResult<ScheduleRow>>
  remove(id: string): Promise<IpcResult<boolean>>
  checkConflict(dto: { startAt: number; endAt: number; excludeId?: string }): Promise<IpcResult<Array<{ id: string; title: string; startAt: number; endAt: number }>>>
  calendars(): Promise<IpcResult<CalendarRow[]>>
  toggleCalendar(dto: { id: string; visible: boolean }): Promise<IpcResult<CalendarRow[]>>
  createCalendar(dto: { name: string; color?: string }): Promise<IpcResult<CalendarRow[]>>
  removeCalendar(id: string): Promise<IpcResult<CalendarRow[]>>
  exportICS(dto?: { from?: number; to?: number }): Promise<IpcResult<string>>
  importICS(dto: { text: string; calendarId?: string }): Promise<IpcResult<{ imported: number }>>
}

export interface PomodoroState { phase: 'idle' | 'running' | 'paused' | 'break'; remainSec: number; round: number; taskId: string | null; endsAt: number | null; plannedSec: number }
export interface PomodoroSessionRow {
  id: string; taskId: string | null; tag: string | null; plannedMin: number; actualMin: number
  startedAt: number; endedAt: number | null; status: string; interruptReason: string | null
}
export interface PomodoroConfig { focusMin: number; shortMin: number; longMin: number; longEvery: number; goal: number }
export interface PomodoroStats { sessions: PomodoroSessionRow[]; count: number; minutes: number; interrupted: number; rate: number }
export interface PomodoroApi {
  state(): Promise<IpcResult<PomodoroState>>
  start(dto?: { minutes?: number; taskId?: string | null }): Promise<IpcResult<PomodoroState>>
  pause(): Promise<IpcResult<PomodoroState>>
  resume(): Promise<IpcResult<PomodoroState>>
  complete(): Promise<IpcResult<PomodoroState>>
  abandon(dto?: { reason?: string }): Promise<IpcResult<PomodoroState>>
  skipBreak(): Promise<IpcResult<PomodoroState>>
  tick(): Promise<IpcResult<PomodoroState>>
  setTask(dto: { taskId: string | null }): Promise<IpcResult<PomodoroState>>
  config(): Promise<IpcResult<PomodoroConfig>>
  saveConfig(patch: Partial<PomodoroConfig>): Promise<IpcResult<PomodoroConfig>>
  stats(dto?: { since?: number }): Promise<IpcResult<PomodoroStats>>
  weekStats(): Promise<IpcResult<Array<{ date: number; minutes: number; count: number }>>>
  recent(limit?: number): Promise<IpcResult<PomodoroSessionRow[]>>
}

export interface WeatherCity { id: string; name: string; home: boolean; sort: number }
export interface WeatherNow { temp: number; cond: string; feel: number; humidity: number; wind: string; pressure: number; visibility: number; uv: number | string; sunrise: string; sunset: string }
export interface WeatherData { cityId: string; name: string; fromCache: boolean; fetchedAt: number; now: WeatherNow; hourly: Array<{ time: string; icon: string; temp: number; pop: number }>; daily: Array<{ dow: string; icon: string; hi: number; lo: number; pop: number }>; aqi: { num: number; level: string; pm25: number; pm10: number; o3: number }; indices: Array<{ name: string; icon: string; text: string }> }
export interface WeatherApi {
  cities(): Promise<IpcResult<WeatherCity[]>>
  addCity(dto: { name: string }): Promise<IpcResult<WeatherCity[]>>
  removeCity(id: string): Promise<IpcResult<WeatherCity[]>>
  setHome(id: string): Promise<IpcResult<WeatherCity[]>>
  fetch(dto: { cityId: string; force?: boolean }): Promise<IpcResult<WeatherData>>
}

export interface FeedItem { id: string; sourceId: string; title: string; link: string | null; author: string | null; summary: string | null; content: string | null; publishedAt: number | null; read: boolean; starred: boolean; readLater: boolean; sourceTitle?: string; group?: string | null }
export interface FeedSource { id: string; url: string; title: string | null; groupId: string | null; intervalMin: number; enabled: boolean; lastFetchAt: number | null }
export interface FeedApi {
  groups(): Promise<IpcResult<Array<{ id: string; name: string }>>>
  addGroup(dto: { name: string }): Promise<IpcResult<Array<{ id: string; name: string }>>>
  sources(): Promise<IpcResult<FeedSource[]>>
  addSource(dto: { url: string; title?: string; groupId?: string | null; intervalMin?: number }): Promise<IpcResult<FeedSource[]>>
  removeSource(id: string): Promise<IpcResult<FeedSource[]>>
  toggleSource(dto: { id: string; enabled: boolean }): Promise<IpcResult<FeedSource[]>>
  updateSource(dto: { id: string; url?: string; title?: string; groupId?: string | null; intervalMin?: number }): Promise<IpcResult<FeedSource>>
  items(filter?: { sourceId?: string; group?: string; kind?: 'unread' | 'starred' | 'later' | 'all' }): Promise<IpcResult<FeedItem[]>>
  markRead(id: string): Promise<IpcResult<boolean>>
  toggleStar(id: string): Promise<IpcResult<boolean>>
  toggleLater(id: string): Promise<IpcResult<boolean>>
  refresh(dto?: { sourceId?: string }): Promise<IpcResult<{ added: number; updated: number; skipped: number; failed: number }>>
  importOPML(dto: { text: string }): Promise<IpcResult<{ imported: number }>>
  exportOPML(): Promise<IpcResult<string>>
}

export interface ParcelRow { id: string; company: string; trackingNo: string; alias: string | null; note: string | null; status: string; pickupCode: string | null; station: string | null; etaAt: number | null; archived: boolean; privacyMasked: boolean; createdAt: number; updatedAt: number }
export interface ParcelTrack { id: string; parcelId: string; nodeTime: number; description: string; location: string | null }
export interface ParcelApi {
  list(filter?: { status?: string; archived?: boolean }): Promise<IpcResult<ParcelRow[]>>
  add(dto: { numbers: string[]; alias?: string; note?: string }): Promise<IpcResult<ParcelRow[]>>
  refresh(id: string): Promise<IpcResult<ParcelRow>>
  tracks(id: string): Promise<IpcResult<ParcelTrack[]>>
  archive(id: string): Promise<IpcResult<boolean>>
  togglePrivacy(dto: { id: string; masked: boolean }): Promise<IpcResult<boolean>>
  toTodoInfo(id: string): Promise<IpcResult<{ title: string; dueAt: number | null; note: string }>>
}

export interface MailAccount { id: string; alias: string; email: string; protocol: string; imapHost: string | null; imapPort: number | null; smtpHost: string | null; smtpPort: number | null; username: string | null; syncDays: number; enabled: boolean; lastSyncAt: number | null }
export interface MailFolder { id: string; accountId: string; name: string; kind: string; unreadCount: number }
export interface MailRow { id: string; accountId: string; folderId: string | null; fromName: string | null; fromAddr: string | null; toAddrs?: string | null; ccAddrs?: string | null; subject: string | null; snippet: string | null; sentAt: number | null; read: boolean; starred: boolean; important: boolean; hasAttach: boolean; labels: string | null; bodyText?: string | null; bodyHtml?: string | null; attachments?: Array<{ id?: string; filename?: string; size?: number; localPath?: string | null }> }
export interface MailApi {
  accounts(): Promise<IpcResult<MailAccount[]>>
  addAccount(dto: Record<string, unknown>): Promise<IpcResult<MailAccount[]>>
  updateAccount(dto: Record<string, unknown>): Promise<IpcResult<MailAccount[]>>
  removeAccount(dto: { id: string }): Promise<IpcResult<MailAccount[]>>
  testAccount(dto: Record<string, unknown>): Promise<IpcResult<{ ok: boolean; code?: string; message?: string; imap?: { ok: boolean; message?: string } | null; smtp?: { ok: boolean; message?: string } | null }>>
  sync(dto: { accountId: string; limit?: number }): Promise<IpcResult<{ ok: boolean; accountId: string; added: number; updated: number; total: number }>>
  folders(accountId?: string): Promise<IpcResult<MailFolder[]>>
  list(filter?: { accountId?: string; folderId?: string; kind?: string; search?: string; unread?: boolean; starred?: boolean }): Promise<IpcResult<MailRow[]>>
  read(id: string): Promise<IpcResult<MailRow>>
  send(dto: Record<string, unknown>): Promise<IpcResult<{ ok: boolean; id: string; delivered: boolean }>>
  saveDraft(dto: Record<string, unknown>): Promise<IpcResult<boolean>>
  markRead(id: string): Promise<IpcResult<boolean>>
  toggleStar(id: string): Promise<IpcResult<boolean>>
  remove(id: string): Promise<IpcResult<boolean>>
  rules(): Promise<IpcResult<Array<Record<string, unknown>>>>
  saveRule(dto: Record<string, unknown>): Promise<IpcResult<boolean>>
  toTodoInfo(id: string): Promise<IpcResult<{ title: string; from: string; subject: string; body: string }>>
}

declare global { interface Window { api: Api } }
export {}

