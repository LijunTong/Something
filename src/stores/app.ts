import { defineStore } from 'pinia'
import { call, bridge, hasBridge, plain, IpcError } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { AllSettings, FeedApi, FeedItem, NotifyCounts, TodoListRow, TodoRow, TodoStats } from '@/types/api'

interface State {
  ready: boolean
  loading: boolean
  error: string | null
  todos: TodoRow[]
  todoLists: TodoListRow[]
  todoStats: TodoStats | null
  settings: AllSettings | null
  runtime: { version: string; userData: string; db: string } | null
  /** 信息流未读数：只做侧栏角标展示，正文列表仍归信息流页 */
  feedUnread: number
  /** 通知未读数：侧栏「通知」角标，与通知页、首页卡片同一口径 */
  noticeUnread: number
}

export const useAppStore = defineStore('app', {
  state: (): State => ({
    ready: false,
    loading: false,
    error: null,
    todos: [],
    todoLists: [],
    todoStats: null,
    settings: null,
    runtime: null,
    feedUnread: 0,
    noticeUnread: 0
  }),

  getters: {
    pendingCount: (s) => s.todos.filter((t) => t.status === '未开始' || t.status === '进行中').length,
    doneCount: (s) => s.todos.filter((t) => t.status === '已完成').length,
    themeMode: (s): '浅色' | '深色' | '跟随系统' => s.settings?.appearance?.theme ?? '浅色',
    fontMode: (s): '小' | '中' | '大' => s.settings?.appearance?.font ?? '小'
  },

  actions: {
    /** 启动：先取设置与运行时信息，再灌首批数据。 */
    async init() {
      if (!hasBridge()) {
        this.error = '未在 Electron 中运行，IPC 不可用'
        this.ready = true
        return
      }
      this.loading = true
      try {
        const [settings, runtime] = await Promise.all([call(() => bridge().settings.all(), null as unknown as AllSettings), call(() => bridge().system.info(), { version: 'dev', userData: '', defaultUserData: '', dataSource: 'default', db: '' })])
        this.settings = settings
        this.runtime = runtime
        await this.refreshTodos()
        await this.refreshFeedUnread()
        await this.refreshNoticeUnread()
        bridge().onDataChanged((p) => {
          if (p.domain === 'todo') void this.refreshTodos()
          if (p.domain === 'settings') void this.refreshSettings()
          if (p.domain === 'notification') void this.refreshNoticeUnread()
        })
        this.ready = true
      } catch (e) {
        this.error = e instanceof IpcError ? e.message : String(e)
        log.exception('store.init', e)
        this.ready = true
      } finally {
        this.loading = false
      }
    },

    async refreshTodos() {
      const [todos, lists, stats] = await Promise.all([
        call(() => bridge().todo.list({}), [] as TodoRow[]),
        call(() => bridge().todo.lists(), [] as TodoListRow[]),
        call(() => bridge().todo.stats(), { pending: 0, done: 0, overdue: 0, focusSeconds: 0 })
      ])
      this.todos = todos
      this.todoLists = lists
      this.todoStats = stats
    },

    /** 侧栏「信息流」角标用：只取未读条数，失败时保持原值 */
    async refreshFeedUnread() {
      const feed = (bridge() as unknown as { feed?: FeedApi }).feed
      if (!feed) return
      const rows = await call(() => feed.items({ kind: 'unread' }), [] as FeedItem[])
      this.feedUnread = rows.length
    },

    setFeedUnread(n: number) {
      this.feedUnread = n
    },

    /** 侧栏「通知」角标：与通知页 counts.unread 同源 */
    async refreshNoticeUnread() {
      const r = await call(() => bridge().notification.counts(), null as unknown as NotifyCounts)
      this.noticeUnread = r ? r.unread : this.noticeUnread
    },

    async refreshSettings() {
      this.settings = await call(() => bridge().settings.all(), null as unknown as AllSettings)
    },

    async addTodo(title: string, extra?: Partial<TodoRow>) {
      // extra 可能来自 ref/computed，直接跨 IPC 会带 Proxy。
      const dto = plain({ title, priority: '中', status: '未开始', ...extra })
      const row = await call(() => bridge().todo.create(dto))
      await this.refreshTodos()
      return row
    },

    async toggleTodo(id: string) {
      await call(() => bridge().todo.toggle(id))
      await this.refreshTodos()
    },

    async updateTodo(dto: Partial<TodoRow> & { id: string }) {
      await call(() => bridge().todo.update(plain(dto)))
      await this.refreshTodos()
    },

    async removeTodo(id: string) {
      await call(() => bridge().todo.remove(id))
      await this.refreshTodos()
    },

    /** 新建清单（同名会复用已有清单），返回落库后的清单行 */
    async createTodoList(name: string) {
      const row = await call(() => bridge().todo.createList({ name }), null as TodoListRow | null)
      await this.refreshTodos()
      return row
    },

    /** 修改清单名称；默认清单同样允许改名 */
    async updateTodoList(id: string, name: string) {
      const row = await call(() => bridge().todo.updateList({ id, name }), null as TodoListRow | null)
      await this.refreshTodos()
      return row
    },

    /** 删除清单：清单下的待办迁移到默认清单，返回迁移条数与承接清单 */
    async removeTodoList(id: string) {
      const res = await call(() => bridge().todo.removeList(id), null as { count: number; defaultList: TodoListRow | null } | null)
      await this.refreshTodos()
      return res
    },

    async addSubtask(todoId: string, title: string) {
      await call(() => bridge().todo.addSubtask({ todoId, title }))
      await this.refreshTodos()
    },

    async toggleSubtask(id: string) {
      await call(() => bridge().todo.toggleSubtask(id))
      await this.refreshTodos()
    },

    async saveSettings(patch: Partial<AllSettings>) {
      this.settings = await call(() => bridge().settings.set(plain(patch)))
    }
  }
})