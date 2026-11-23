// 白名单桥：渲染进程只能调用这里显式列出的方法，没有通用 invoke。
const { contextBridge, ipcRenderer } = require('electron')

function call(channel) {
  return function (payload) { return ipcRenderer.invoke(channel, payload) }
}

const api = {
  todo: {
    list: call('todo:list'), get: call('todo:get'), create: call('todo:create'),
    update: call('todo:update'), toggle: call('todo:toggle'), remove: call('todo:remove'),
    reorder: call('todo:reorder'), addSubtask: call('todo:addSubtask'),
    toggleSubtask: call('todo:toggleSubtask'), lists: call('todo:lists'), stats: call('todo:stats'),
    createList: call('todo:createList'), updateList: call('todo:updateList'),
    removeList: call('todo:removeList')
  },
  schedule: {
    range: call('schedule:range'), get: call('schedule:get'), create: call('schedule:create'),
    update: call('schedule:update'), remove: call('schedule:remove'),
    checkConflict: call('schedule:checkConflict'),
    calendars: call('schedule:calendars'), toggleCalendar: call('schedule:toggleCalendar'),
    createCalendar: call('schedule:createCalendar'), updateCalendar: call('schedule:updateCalendar'),
    calendarUsage: call('schedule:calendarUsage'), removeCalendar: call('schedule:removeCalendar'),
    exportICS: call('schedule:exportICS'), importICS: call('schedule:importICS')
  },
  pomodoro: {
    state: call('pomodoro:state'), start: call('pomodoro:start'), pause: call('pomodoro:pause'),
    resume: call('pomodoro:resume'), complete: call('pomodoro:complete'),
    abandon: call('pomodoro:abandon'), skipBreak: call('pomodoro:skipBreak'),
    tick: call('pomodoro:tick'), setTask: call('pomodoro:setTask'),
    config: call('pomodoro:config'), saveConfig: call('pomodoro:saveConfig'),
    stats: call('pomodoro:stats'), weekStats: call('pomodoro:weekStats'), recent: call('pomodoro:recent')
  },
  weather: {
    cities: call('weather:cities'), addCity: call('weather:addCity'),
    removeCity: call('weather:removeCity'), setHome: call('weather:setHome'),
    searchCities: call('weather:searchCities'),
    relocate: call('weather:relocate'),
    fetch: call('weather:fetch')
  },
  feed: {
    groups: call('feed:groups'), addGroup: call('feed:addGroup'),
    updateGroup: call('feed:updateGroup'), removeGroup: call('feed:removeGroup'),
    sources: call('feed:sources'), addSource: call('feed:addSource'),
    removeSource: call('feed:removeSource'), toggleSource: call('feed:toggleSource'),
    updateSource: call('feed:updateSource'),
    items: call('feed:items'), detail: call('feed:detail'), markRead: call('feed:markRead'),
    markReadMany: call('feed:markReadMany'), removeItems: call('feed:removeItems'),
    toggleStar: call('feed:toggleStar'), toggleLater: call('feed:toggleLater'),
    refresh: call('feed:refresh'), importOPML: call('feed:importOPML'), exportOPML: call('feed:exportOPML')
  },
  parcel: {
    list: call('parcel:list'), get: call('parcel:get'), add: call('parcel:add'), refresh: call('parcel:refresh'),
    tracks: call('parcel:tracks'), archive: call('parcel:archive'),
    togglePrivacy: call('parcel:togglePrivacy'), toTodoInfo: call('parcel:toTodoInfo')
  },
  mail: {
    accounts: call('mail:accounts'), addAccount: call('mail:addAccount'),
    updateAccount: call('mail:updateAccount'), removeAccount: call('mail:removeAccount'),
    revealSecret: call('mail:revealSecret'),
    testAccount: call('mail:testAccount'), sync: call('mail:sync'), folders: call('mail:folders'),
    list: call('mail:list'), read: call('mail:read'), send: call('mail:send'), saveDraft: call('mail:saveDraft'),
    markRead: call('mail:markRead'), markUnread: call('mail:markUnread'),
    toggleStar: call('mail:toggleStar'), remove: call('mail:remove'),
    rules: call('mail:rules'), saveRule: call('mail:saveRule'), toTodoInfo: call('mail:toTodoInfo')
  },
  settings: {
    all: call('settings:all'), get: call('settings:get'), set: call('settings:set'),
    storage: call('settings:storage'), backup: call('settings:backup'), backups: call('settings:backups'),
    restore: call('settings:restore'), exportData: call('settings:exportData'),
    clearCache: call('settings:clearCache'), clearTrash: call('settings:clearTrash'),
    resetAll: call('settings:resetAll'), setWeatherKey: call('settings:setWeatherKey'),
    setWeatherJwt: call('settings:setWeatherJwt'), clearWeatherJwt: call('settings:clearWeatherJwt'),
    revealSecret: call('settings:revealSecret'), testWeather: call('settings:testWeather')
  },
  search: { query: call('search:query') },
  notification: {
    today: call('notification:today'), unreadCount: call('notification:unreadCount'),
    markAllRead: call('notification:markAllRead'), create: call('notification:create'),
    remove: call('notification:remove'),
    counts: call('notification:counts'), list: call('notification:list'),
    get: call('notification:get'),
    markRead: call('notification:markRead'), clearRead: call('notification:clearRead'),
    // 事件上报：主进程统一决定系统通知/应用内通知（去重、免打扰、隐私都在主进程判定）
    push: call('notification:push'), test: call('notification:test'),
    // 应用内通知浮层订阅：主进程推送事件时回调
    onEvent: function (cb) {
      const handler = function (_e, payload) { cb(payload) }
      ipcRenderer.on('notify:event', handler)
      return function () { ipcRenderer.removeListener('notify:event', handler) }
    }
  },
  log: {
    write: call('log:write'),
    error: call('log:error'),
    path: call('log:path'),
    files: call('log:files')
  },
  system: {
    info: call('system:info'), ping: call('system:ping'), openPath: call('system:openPath'),
    openExternal: call('system:openExternal'), chooseDir: call('system:chooseDir'),
    checkUpdate: call('system:checkUpdate'),
    setLaunchAtLogin: call('system:setLaunchAtLogin'), loginItemEnabled: call('system:loginItemEnabled'),
    trayInfo: call('system:trayInfo'), trayHint: call('system:trayHint')
  },
  window: {
    minimize: call('window:minimize'), toggleMaximize: call('window:toggleMaximize'),
    close: call('window:close'), isMaximized: call('window:isMaximized'),
    isMinimized: call('window:isMinimized'),
    setFullScreen: call('window:setFullScreen'), isFullScreen: call('window:isFullScreen')
  },
  onWindowMaximized: function (cb) {
    const handler = function (_e, value) { cb(!!value) }
    ipcRenderer.on('window:maximized', handler)
    return function () { ipcRenderer.removeListener('window:maximized', handler) }
  },
  onNavigate: function (cb) {
    const handler = function (_e, to) { cb(String(to || '/')) }
    ipcRenderer.on('app:navigate', handler)
    return function () { ipcRenderer.removeListener('app:navigate', handler) }
  },
  onDataChanged: function (cb) {
    const handler = function (_e, payload) { cb(payload) }
    ipcRenderer.on('data:changed', handler)
    return function () { ipcRenderer.removeListener('data:changed', handler) }
  }
}

contextBridge.exposeInMainWorld('api', api)
