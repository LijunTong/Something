// 渲染进程与主进程 IPC 类型契约
export interface IpcResult<T> { ok: boolean; data?: T; error?: { code: string; message: string } }

/** 检查更新结果：版本号唯一来源是 package.json 的 version，发布 tag 为 v + version */
export interface UpdateCheckResult {
  /** 当前应用版本（app.getVersion()，即 package.json.version） */
  current: string
  /** GitHub 最新正式发布的版本号（去掉 tag 前缀 v），无发布时为 null */
  latest: string | null
  hasUpdate: boolean
  /** 对应发布页地址，或有更新时直接指向该版本 */
  url: string
  repo: string
  name: string | null
  publishedAt: string | null
  notes: string
  /** 该版本对应的 Windows 安装包；没有可下载资源时为 null */
  asset: { name: string; url: string; size: number } | null
  /** 仓库还没有任何正式发布 */
  noRelease: boolean
  checkedAt: number
}

/** 自动更新进度：主进程下载/安装安装包时推送，state 变化或下载百分比前进 */
export interface UpdateProgressEvent {
  state: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
  version: string | null
  /** 0-100；未知总大小时为 0 */
  percent: number
  received: number
  total: number
  /** 出错时的可读原因 */
  message?: string
}

export interface TodoListRow { id: string; name: string; color: string | null; sort: number; isDefault?: boolean; deletedAt?: number | null }
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
  /** 应用内通知：通知表（今日通知）+ 应用内浮层 */
  inApp: boolean
  /** 系统通知：Windows 通知中心 toast */
  desktop: boolean
  /** 系统通知仅在窗口不在前台时弹出，前台只走应用内 */
  systemOnlyAway: boolean
  weather: boolean; schedule: boolean; todo: boolean
  pomodoro: boolean; parcel: boolean; mail: boolean
  /** 免打扰时段总开关：关掉后 dndStart/dndEnd 仅作为下次开启时的记忆值 */
  dndOn: boolean
  dndStart: string; dndEnd: string; privacy: string
  /** 每个模块的提示音（音频名，默认「蜂鸣」），缺失时回退蜂鸣 */
  sounds: NotifySounds
}
export type NotifySoundModule = 'weather' | 'schedule' | 'todo' | 'pomodoro' | 'parcel' | 'mail'
export type NotifySounds = Record<NotifySoundModule, string>
export interface ShortcutSetting {
  search: string; newTodo: string; focus: string
  /** 历史字段：快捷添加按钮已移除，仅保留兼容 */
  quickAdd?: string
}
export interface BackupSetting {
  auto: boolean; path: string; freq: '每天' | '每周' | '每次退出'
  /** 最多保留的备份份数，超出后删除最旧的（1-100，默认 10） */
  keep: number
  encrypted: boolean; passwordSet: boolean; lastAt: number | null; lastFile: string | null
}
export interface WeatherSetting {
  source: string; host: string; geoHost: string
  /** cacheMin 为兼容字段；refreshMin 是自动刷新频率（分钟，默认 5） */
  cacheMin: number; refreshMin?: number
  /** 设置面板里选中的认证方式，只影响表单展示 */
  authType?: 'jwt' | 'key'
  offlineCache: boolean; alertPush: boolean; unit: 'C' | 'F'
  /** 凭据状态：apiKeySet/jwtSet 只表示是否已保存；apiKeyHint 只给尾号，私钥永不回显 */
  apiKeySet: boolean; apiKeyHint?: string; jwtSet?: boolean
  jwtMeta?: { developerId: string; projectId: string; keyId: string; privateKeySet: boolean } | null
  authMode?: 'jwt' | 'key' | 'none'
}
export interface FeedSetting { defaultInterval: number; keepContent: boolean }
/** 首页卡片显隐：true 表示在首页显示该卡片 */
export interface ModulesSetting {
  dashboard: boolean; weather: boolean; schedule: boolean; todo: boolean
  pomodoro: boolean; feed: boolean; parcel: boolean; mail: boolean; notice: boolean
}
/** 首页卡片布局：x/y 为网格坐标（列 0..2、行从 0 起），w/h 为网格单位（行高 40px，间距 16px） */
export interface HomeCardLayout {
  key: 'weather' | 'schedule' | 'todo' | 'pomodoro' | 'feed' | 'parcel' | 'mail' | 'notice'
  x: number
  y: number
  w: number
  h: number
}
export interface HomeSetting {
  layout: HomeCardLayout[]
  /** 锁定后首页卡片不能拖动、不能缩放 */
  locked: boolean
}
/** 桌面挂件：首页卡片「复制」到桌面的独立透明浮窗，一卡一件（id 固定为 w-<card>） */
export interface WidgetItem {
  id: string
  card: 'weather' | 'schedule' | 'todo' | 'pomodoro' | 'feed' | 'parcel' | 'mail' | 'notice'
  /** 屏幕坐标（CSS px，主进程按显示器 workArea 夹取） */
  x: number
  y: number
  w: number
  h: number
  /** 总在最前（浮在浏览器/编辑器之上） */
  alwaysOnTop: boolean
  /** 锁定后挂件上不显示拖动/缩放把手 */
  locked: boolean
}
export interface WidgetsSetting {
  items: WidgetItem[]
  /** false 时挂件卡片画不透明底（窗口本身始终透明，避免 Windows 合成失败） */
  useTransparent: boolean
}
/** 一次挂件写入的结果：created=false 表示这张卡已经在桌面上了 */
export interface WidgetDropResult {
  id?: string
  created: boolean
  reason: 'ok' | 'exists' | 'inside'
}
export interface WidgetListResult {
  items: WidgetItem[]
  /** 同时最多能钉几张卡到桌面 */
  max: number
  /** 当前活着的挂件窗口数（无头自测时用它断言） */
  live: number
}
/** setBounds 的回执：clamped 标出哪几个方向被屏幕边界夹住了（窗口据此提示） */
export interface WidgetBoundsResult {
  x: number
  y: number
  width: number
  height: number
  clamped: { x: boolean; y: boolean; w: boolean; h: boolean }
}
export interface WindowSetting {
  /** 关闭窗口时隐藏到托盘（不退出进程） */
  closeToTray: boolean
  /** 最小化时隐藏到托盘 */
  minimizeToTray: boolean
  /** 开机自动启动（同时写入系统登录项） */
  launchAtLogin: boolean
}
/** 邮件设置：autoSyncMin 是自动同步间隔（分钟，默认 15）；0 表示关闭自动同步 */
export interface MailSetting {
  autoSyncMin: number
}
/** Agent 接入：本机 MCP 服务开关与端口（令牌不落在设置对象里） */
export interface McpSetting {
  enabled: boolean
  /** 手动指定的监听端口，1024-65535；null 表示按环境取默认 */
  port: number | null
}
/** 端口来源：env=TK_MCP_PORT 覆盖，setting=设置里保存过，default=按开发/安装版默认 */
export type McpPortSource = 'env' | 'setting' | 'default'
export interface McpStatus {
  enabled: boolean; port: number; configuredPort: number | null; portSource: McpPortSource
  endpoint: string | null
  tokenSet: boolean; calls: number; lastCallAt: number | null; lastTool: string | null
  lastError: string | null
}
/** 项目计划的只读元信息：待办页计划条与设置页用 */
export interface PlanMeta {
  listId: string; projectKey: string; title: string; summary: string | null
  version: string | null; revision: number; updatedAt: number; source: string
  lastWriter: string | null; repoPath: string | null; total: number; done: number
}
export interface AllSettings {
  appearance: AppearanceSetting; notify: NotifySetting; shortcuts: ShortcutSetting; window: WindowSetting
  backup: BackupSetting; weather: WeatherSetting; feed: FeedSetting; modules: ModulesSetting
  mail: MailSetting
  mcp: McpSetting
  parcel: ParcelSetting
  home: HomeSetting
  widgets: WidgetsSetting
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
export interface WeatherTestResult {
  ok: boolean; keySet: boolean; authMode?: 'jwt' | 'key' | 'none'
  host: string; geoHost?: string; cacheMin: number
  message: string; city?: string; code?: string
}
export interface SearchItem { id: string; title: string; meta: string; target: string }
export interface SearchGroup { module: string; label: string; items: SearchItem[] }
export interface NotificationItem {
  id: string; module: string; level: string; title: string; body: string | null
  at: number; read: boolean; derived?: boolean
}
export interface NotifyListQuery { module?: string; onlyUnread?: boolean; limit?: number; offset?: number }
export interface NotifyCounts { total: number; unread: number; byModule: Record<string, number> }
export interface NotifyPage { items: NotificationItem[]; total: number; offset: number; limit: number; hasMore: boolean }
/** 主进程推送的事件（应用内浮层消费）：与 notification 表里的行同源 */
export interface NotificationEvent {
  /** 提示音名，渲染层据此播放 assets/sounds 里的音频 */
  sound?: string
  id: string; module: string; level: 'normal' | 'strong'
  title: string; body: string | null; at: number
}
/** 事件上报结果：两条通道各自是否真的推送成功 */
export interface NotifyPushResult {
  ok: boolean; id: string | null; inApp: boolean; system: boolean
  reason: string | null
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
    /** 新建清单；同名（忽略大小写）已存在时直接返回原有清单 */
    createList(dto: { name: string; color?: string | null }): Promise<IpcResult<TodoListRow>>
    /** 修改清单名称；默认清单同样允许改名 */
    updateList(dto: { id: string; name: string }): Promise<IpcResult<TodoListRow>>
    /** 删除清单：清单下的待办迁移到默认清单，返回迁移条数与承接清单 */
    removeList(id: string): Promise<IpcResult<{ list: TodoListRow; count: number; defaultList: TodoListRow | null }>>
    stats(): Promise<IpcResult<TodoStats>>
  }
  schedule: ScheduleApi
  pomodoro: PomodoroApi
  weather: WeatherApi
  feed: FeedApi
  parcel: ParcelApi
  mail: MailApi
  project: {
    planMeta(dto: { listId: string }): Promise<IpcResult<PlanMeta | null>>
  }
  mcp: {
    status(): Promise<IpcResult<McpStatus>>
    setEnabled(dto: { enabled: boolean; port?: number }): Promise<IpcResult<McpStatus>>
    revealToken(): Promise<IpcResult<{ token: string }>>
    rotateToken(): Promise<IpcResult<{ token: string }>>
  }
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
    /** JWT 凭据：开发者 ID / 项目 ID / 凭据 ID / Ed25519 私钥（PEM） */
    setWeatherJwt(dto: { developerId: string; projectId: string; keyId: string; privateKey?: string }): Promise<IpcResult<WeatherSetting>>
    /** 凭据明文回显：界面默认掩码，用户点「显示」时按需取明文 */
  revealSecret(dto: { kind: 'weatherKey' | 'weatherJwt' }): Promise<IpcResult<{ kind: string; value: string }>>
  clearWeatherJwt(): Promise<IpcResult<WeatherSetting>>
    testWeather(): Promise<IpcResult<WeatherTestResult>>
    /** 快递数据源凭据：values 里空串字段表示删除 */
    setParcelCredential(dto: { provider: 'kuaidi100' | 'kdniao' | 'juhe'; values: Record<string, string> }): Promise<IpcResult<ParcelSetting>>
    clearParcelCredential(dto: { provider: 'kuaidi100' | 'kdniao' | 'juhe' }): Promise<IpcResult<ParcelSetting>>
    /** 凭据明文回显：界面默认掩码，点「显示」时按需取 */
    revealParcelCredential(dto: { provider: 'kuaidi100' | 'kdniao' | 'juhe' }): Promise<IpcResult<{ provider: string; values: Record<string, string> }>>
  }
  search: {
    query(dto: { keyword: string }): Promise<IpcResult<{ keyword: string; total: number; groups: SearchGroup[] }>>
  }
  notification: {
    today(): Promise<IpcResult<NotificationItem[]>>
    unreadCount(): Promise<IpcResult<number>>
    markAllRead(): Promise<IpcResult<number>>
    counts(): Promise<IpcResult<NotifyCounts>>
    list(dto?: NotifyListQuery): Promise<IpcResult<NotifyPage>>
    /** 单条：仪表盘深链定位用，查不到返回 null */
    get(id: string): Promise<IpcResult<NotificationItem | null>>
    markRead(id: string): Promise<IpcResult<boolean>>
    clearRead(): Promise<IpcResult<number>>
    create(dto: { module: string; level?: string; title: string; body?: string }): Promise<IpcResult<string>>
    remove(id: string): Promise<IpcResult<boolean>>
    /** 事件上报：主进程统一决定系统通知/应用内通知，并做去重、免打扰、隐私判定 */
    push(dto: { module: string; title: string; body?: string; level?: 'normal' | 'strong'; id?: string }): Promise<IpcResult<NotifyPushResult>>
    /** 设置页自检：两条通道各回结果 */
    test(): Promise<IpcResult<NotifyPushResult>>
    onEvent(cb: (event: NotificationEvent) => void): () => void
  }
  log: {
    write(dto: { level?: 'debug' | 'info' | 'warn' | 'error'; scope?: string; message: string; meta?: unknown }): Promise<IpcResult<boolean>>
    error(dto: { scope?: string; message: string; stack?: string; info?: string; location?: string; meta?: unknown }): Promise<IpcResult<boolean>>
    path(): Promise<IpcResult<{ file: string | null; dir: string | null }>>
    files(): Promise<IpcResult<string[]>>
  }
  window: {
    minimize(): Promise<IpcResult<boolean>>
    toggleMaximize(): Promise<IpcResult<boolean>>
    close(): Promise<IpcResult<boolean>>
    isMaximized(): Promise<IpcResult<boolean>>
    isMinimized(): Promise<IpcResult<boolean>>
    setFullScreen(dto: { on: boolean }): Promise<IpcResult<boolean>>
    isFullScreen(): Promise<IpcResult<boolean>>
  }
  widget: {
    list(): Promise<IpcResult<WidgetListResult>>
    /** 直接在某处创建（坐标缺省时落在主屏右上角） */
    create(dto: { card: WidgetItem['card']; x?: number; y?: number; alwaysOnTop?: boolean }): Promise<IpcResult<WidgetDropResult>>
    /** 首页松手时调：光标仍在主窗口内则返回 reason='inside'，由首页布局自己落库 */
    dropAtCursor(dto: { card: WidgetItem['card'] }): Promise<IpcResult<WidgetDropResult>>
    remove(dto: { id: string }): Promise<IpcResult<boolean>>
    removeAll(): Promise<IpcResult<boolean>>
    patch(dto: { id: string; patch: { alwaysOnTop?: boolean; locked?: boolean } }): Promise<IpcResult<WidgetItem>>
    /** 首页按下卡片标题时开监视：窗口外收不到 DOM 事件，越界由主进程轮询光标判定 */
    armDrag(dto: { card: WidgetItem['card'] }): Promise<IpcResult<boolean>>
    disarmDrag(): Promise<IpcResult<boolean>>
    /** 缩放：左上角也在动（从左边/上边拉），位置与尺寸一起给，避免中间态 */
    setBounds(dto: { id: string; x: number; y: number; w: number; h: number }): Promise<IpcResult<WidgetBoundsResult | null>>
    bounds(dto: { id: string }): Promise<IpcResult<{ x: number; y: number; width: number; height: number } | null>>
    focus(dto: { id: string }): Promise<IpcResult<boolean>>
    /** 挂件里点内容时把主窗口叫到前台并导航（挂件是独立渲染进程，不能就地跳转） */
    navigateMain(dto: { to: string }): Promise<IpcResult<boolean>>
    showAll(): Promise<IpcResult<number>>
    hideAll(): Promise<IpcResult<number>>
  }
  /** 拖动中的卡片被拖出主窗口：回推一次，渲染层负责收尾与创建 */
  onWidgetDragOut(cb: (payload: { card: WidgetItem['card'] }) => void): () => void
  system: {
    info(): Promise<IpcResult<{ version: string; userData: string; defaultUserData: string; dataSource: string; db: string }>>
    /** 检查更新：读 GitHub 最新正式发布并与当前版本比对 */
    checkUpdate(): Promise<IpcResult<UpdateCheckResult>>
    /** 自动更新：返回当前下载/安装进度快照，面板重挂载时恢复显示 */
    updateStatus(): Promise<IpcResult<UpdateProgressEvent>>
    /** 自动更新：开始下载最新版安装包；进度通过 onUpdateProgress 推送 */
    downloadUpdate(): Promise<IpcResult<{ started: boolean; hasUpdate: boolean; version: string | null; noAsset?: boolean }>>
    /** 自动更新：启动安装程序并退出应用 */
    installUpdate(): Promise<IpcResult<boolean>>
    chooseDir(dto?: { title?: string; defaultPath?: string }): Promise<IpcResult<{ path: string | null }>>
    ping(): Promise<IpcResult<string>>
    openPath(p: string): Promise<IpcResult<boolean>>
    openExternal(dto: { url: string }): Promise<IpcResult<boolean>>
    setLaunchAtLogin(dto: { enabled: boolean }): Promise<IpcResult<boolean>>
    loginItemEnabled(): Promise<IpcResult<boolean>>
    trayHint(): Promise<IpcResult<boolean>>
    trayInfo(): Promise<IpcResult<{ created: boolean; alive: boolean; iconPath: string; iconEmpty: boolean; iconSize: { width: number; height: number } | null; bounds: { x: number; y: number; width: number; height: number } | null }>>
  }
  onDataChanged(cb: (payload: { domain: string; action: string; at: number }) => void): () => void
  onUpdateProgress(cb: (payload: UpdateProgressEvent) => void): () => void
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
  onNavigate(cb: (to: string) => void): () => void
}
export interface ScheduleRow {
  id: string; title: string; startAt: number; endAt: number; allDay: boolean
  place: string | null; calendarId: string | null; calendarName: string | null; calendarColor: string | null
  remindMin: number; recurRule: string | null; note: string | null; status: string
  instanceAt?: number; occurrence?: boolean
}
export interface CalendarRow { id: string; name: string; color: string; visible: boolean; sort: number; isDefault?: boolean }
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
  /** 修改分组名称；默认分组同样允许改名 */
  updateCalendar(dto: { id: string; name: string }): Promise<IpcResult<CalendarRow[]>>
  /** 分组内日程条数（含非当月），用于删除前提示 */
  calendarUsage(id: string): Promise<IpcResult<number>>
  /** 删除分组：分组内的日程迁移到默认分组 */
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

export interface WeatherCity {
  id: string; name: string; home: boolean; sort: number
  /** 和风天气 LocationID 与经纬度：由 GeoAPI 城市搜索写入 */
  qweatherId?: string | null; lat?: number | null; lon?: number | null
  adm1?: string | null; adm2?: string | null
}
export interface WeatherCitySearchResult {
  qweatherId: string; name: string
  lat: number; lon: number
  adm1: string | null; adm2: string | null; country: string | null; type?: string | null
}
export interface WeatherNow {
  temp: number; cond: string; feel: number; humidity: number; wind: string
  pressure: number; visibility: number; uv: number | string; sunrise: string; sunset: string
  obsTime?: string; precip?: number | null; cloud?: number | null; dew?: number | null
}
export interface WeatherHourly { time: string; icon: string; temp: number; pop: number; text?: string; wind?: string; windScale?: string; iconCode?: string }
export interface WeatherDaily {
  dow: string; icon: string; hi: number; lo: number; pop: number
  date?: string; iconNight?: string; iconCode?: string
  textDay?: string; textNight?: string; sunrise?: string; sunset?: string
  uvIndex?: number | null; windDirDay?: string; windScaleDay?: string; moonPhase?: string
}
export interface WeatherAqi {
  num: number; level: string; pm25: number; pm10: number; o3: number
  primary?: string; no2?: number | null; so2?: number | null; co?: number | null
}
export interface WeatherAlert { id: string; title: string; type?: string; level?: string; text?: string; time?: string }
export type WeatherSource = 'qweather' | 'cache'
export interface WeatherData {
  cityId: string; name: string; fromCache: boolean; fetchedAt: number
  now: WeatherNow; hourly: WeatherHourly[]; daily: WeatherDaily[]
  aqi: WeatherAqi; indices: Array<{ name: string; icon: string; text: string }>
  alerts: WeatherAlert[]
  /** 数据来源：和风天气 / 本地缓存 / 本地模拟 */
  source: WeatherSource
  updateTime?: string
  /** 取数失败时的原因（有缓存时仍返回内容） */
  error?: string | null
}
export interface WeatherApi {
  cities(): Promise<IpcResult<WeatherCity[]>>
  /** 新增城市：携带用户选中的 GeoAPI 结果时直接用它的 LocationID，否则按名称定位 */
  addCity(dto: { name: string; qweatherId?: string; lat?: number | null; lon?: number | null; adm1?: string | null; adm2?: string | null }): Promise<IpcResult<WeatherCity>>
  /** 城市搜索：GeoAPI 候选列表（最多 10 条） */
  searchCities(dto: { keyword: string }): Promise<IpcResult<WeatherCitySearchResult[]>>
  removeCity(id: string): Promise<IpcResult<WeatherCity[]>>
  setHome(id: string): Promise<IpcResult<WeatherCity[]>>
  fetch(dto: { cityId: string; force?: boolean }): Promise<IpcResult<WeatherData>>
  /** 重新经 GeoAPI 定位（补齐 LocationID 与经纬度） */
  relocate(dto?: { id?: string }): Promise<IpcResult<{ cities: WeatherCity[]; failed: string[] }>>
}

export interface FeedItem { id: string; sourceId: string; title: string; link: string | null; author: string | null; summary: string | null; content: string | null; /** 正文 HTML：仅 detail() 返回，列表接口不带 */ contentHtml?: string | null; publishedAt: number | null; read: boolean; starred: boolean; readLater: boolean; sourceTitle?: string; group?: string | null; /** 正文是否为抓取补全的全文（false = 仅 RSS 摘要） */ fullText?: boolean; /** 最近一次抓原文的时间戳；null = 还没抓过 */ fullFetchAt?: number | null; /** 是否已成功抓到全文 */ fullFetchOk?: boolean }
export interface FeedSource { id: string; url: string; title: string | null; groupId: string | null; intervalMin: number; enabled: boolean; lastFetchAt: number | null }
/** 订阅分类：color 用于侧栏色点；isDefault 的分类可改名、不可删除 */
export interface FeedGroupRow { id: string; name: string; color: string; isDefault?: boolean }
export interface FeedApi {
  groups(): Promise<IpcResult<FeedGroupRow[]>>
  addGroup(dto: { name: string }): Promise<IpcResult<FeedGroupRow[]>>
  updateGroup(dto: { id: string; name: string }): Promise<IpcResult<FeedGroupRow[]>>
  removeGroup(id: string): Promise<IpcResult<{ groups: FeedGroupRow[]; count: number; defaultGroup: FeedGroupRow | null }>>
  sources(): Promise<IpcResult<FeedSource[]>>
  addSource(dto: { url: string; title?: string; groupId?: string | null; intervalMin?: number }): Promise<IpcResult<FeedSource[]>>
  removeSource(id: string): Promise<IpcResult<FeedSource[]>>
  toggleSource(dto: { id: string; enabled: boolean }): Promise<IpcResult<FeedSource[]>>
  updateSource(dto: { id: string; url?: string; title?: string; groupId?: string | null; intervalMin?: number }): Promise<IpcResult<FeedSource>>
  items(filter?: { sourceId?: string; group?: string; kind?: 'unread' | 'starred' | 'later' | 'all' }): Promise<IpcResult<FeedItem[]>>
  /** force=true 表示忽略失败冷却期，重新抓一次原文全文 */
  detail(dto: { id: string; force?: boolean }): Promise<IpcResult<FeedItem>>
  markRead(id: string): Promise<IpcResult<boolean>>
  /** 批量标记已读：工具栏多选，返回实际更新条数 */
  markReadMany(dto: { ids: string[] }): Promise<IpcResult<number>>
  /** 批量删除文章：只删文章，不动订阅源，返回实际删除条数 */
  removeItems(dto: { ids: string[] }): Promise<IpcResult<number>>
  toggleStar(id: string): Promise<IpcResult<boolean>>
  toggleLater(id: string): Promise<IpcResult<boolean>>
  refresh(dto?: { sourceId?: string }): Promise<IpcResult<{ added: number; updated: number; skipped: number; failed: number }>>
  importOPML(dto: { text: string }): Promise<IpcResult<{ imported: number }>>
  exportOPML(): Promise<IpcResult<string>>
}

export interface ParcelRow {
  id: string; company: string; trackingNo: string; alias: string | null; note: string | null
  status: string; pickupCode: string | null; station: string | null; etaAt: number | null
  archived: boolean; privacyMasked: boolean; createdAt: number; updatedAt: number
  /** 各数据源自己的快递公司编码（如 shunfeng / SF / sf），刷新时现算 */
  courierCode?: string | null
  /** 顺丰等需要手机号后四位才能查到轨迹 */
  phoneTail?: string | null
  /** 上次成功查询所用的数据源 id；manual 表示手动维护 */
  provider?: string | null
  /** 数据源返回的原始状态码，排查用，界面不直接展示 */
  providerState?: string | null
  lastSyncAt?: number | null
  /** 上次失败原因，格式 code|message；成功刷新后清空 */
  lastError?: string | null
}
export interface ParcelProviderField { key: string; label: string; placeholder: string; secret: boolean }
export interface ParcelProvider {
  id: 'manual' | 'kuaidi100' | 'kdniao' | 'juhe'; name: string; site: string; desc: string
  fields: ParcelProviderField[]
  /** 当前设置里选中的就是它 */
  active: boolean
  /** 手动模式恒为 true；其余数据源填齐必填字段才算 true */
  configured: boolean
  /** 已保存的字段 key 列表 */
  filled: string[]
  /** 已保存字段的掩码尾号，不含明文 */
  hints: Record<string, string>
}
export interface ParcelRefreshResult {
  parcel: ParcelRow | null
  provider: string
  added: number
  statusChanged: boolean
  error: { code: string; message: string } | null
}
export interface ParcelRefreshAllResult {
  total: number; added: number; changed: number; failed: number; provider: string
  /** 失败原因摘要，最多 3 条，用于批量刷新后就地提示 */
  errors?: string[]
}
export interface ParcelTestResult {
  ok: boolean; code: string; message: string
  company?: string; status?: string; traces?: number
}
/** 快递设置：provider=manual 表示只手动维护；autoRefreshMin 为自动刷新间隔（分钟，0 关闭） */
export interface ParcelSetting {
  provider: string
  autoRefreshMin: number
  detectCompany: boolean
  /** 各数据源的凭据填写状态，由主进程按凭据推算，不落库 */
  credentials?: Record<string, { set: boolean; filled: string[]; hints: Record<string, string> }>
}
export interface ParcelTrack { id: string; parcelId: string; nodeTime: number; description: string; location: string | null }
export interface ParcelApi {
  list(filter?: { status?: string; archived?: boolean }): Promise<IpcResult<ParcelRow[]>>
  /** 单条：仪表盘深链定位用，查不到返回 null */
  get(id: string): Promise<IpcResult<ParcelRow | null>>
  /** 新增：company / phoneTail 可选，不传则按单号前缀自动识别公司 */
  add(dto: { numbers: string[]; alias?: string; note?: string; company?: string; phoneTail?: string }): Promise<IpcResult<ParcelRow[]>>
  /** 刷新单条：兼容旧调用只传 id；带公司/手机号后四位时会先落库再查询 */
  refresh(idOrDto: string | { id: string; company?: string; phoneTail?: string }): Promise<IpcResult<ParcelRefreshResult>>
  /** 一键刷新：默认只刷未签收，force 为真时连已签收也重查 */
  refreshAll(dto?: { force?: boolean }): Promise<IpcResult<ParcelRefreshAllResult>>
  /** 数据源清单与凭据填写状态（不含明文） */
  providers(): Promise<IpcResult<ParcelProvider[]>>
  /** 快递公司选项，新增包裹时手选用 */
  companies(): Promise<IpcResult<Array<{ name: string; short: string }>>>
  /** 用真实单号试查一次，不写库 */
  testProvider(dto: { provider?: string; no?: string; company?: string; phoneTail?: string; values?: Record<string, string> }): Promise<IpcResult<ParcelTestResult>>
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
  /** 明文回显授权码：默认掩码，点「显示」时按需取 */
  revealSecret(dto: { id: string }): Promise<IpcResult<{ id: string; value: string }>>
  testAccount(dto: Record<string, unknown>): Promise<IpcResult<{ ok: boolean; code?: string; message?: string; imap?: { ok: boolean; message?: string } | null; smtp?: { ok: boolean; message?: string } | null }>>
  sync(dto: { accountId: string; limit?: number; unseenLimit?: number }): Promise<IpcResult<{ ok: boolean; accountId: string; added: number; updated: number; total: number }>>
  folders(accountId?: string): Promise<IpcResult<MailFolder[]>>
  list(filter?: { accountId?: string; folderId?: string; kind?: string; search?: string; unread?: boolean; starred?: boolean }): Promise<IpcResult<MailRow[]>>
  read(id: string): Promise<IpcResult<MailRow>>
  send(dto: Record<string, unknown>): Promise<IpcResult<{ ok: boolean; id: string; delivered: boolean }>>
  saveDraft(dto: Record<string, unknown>): Promise<IpcResult<boolean>>
  markRead(id: string): Promise<IpcResult<boolean>>
  /** 主进程 schema 是 z.object({ id })，这里必须传对象 */
  markUnread(dto: { id: string }): Promise<IpcResult<boolean>>
  toggleStar(id: string): Promise<IpcResult<boolean>>
  remove(id: string): Promise<IpcResult<boolean>>
  rules(): Promise<IpcResult<Array<Record<string, unknown>>>>
  saveRule(dto: Record<string, unknown>): Promise<IpcResult<boolean>>
  toTodoInfo(id: string): Promise<IpcResult<{ title: string; from: string; subject: string; body: string }>>
}

declare global { interface Window { api: Api } }
export {}

