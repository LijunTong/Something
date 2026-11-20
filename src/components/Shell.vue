<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NScrollbar, NText } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { log } from '@/lib/logger'
import { bridge, call, hasBridge } from '@/lib/ipc'
import type { AppearanceSetting } from '@/types/api'
import Icons from './Icons.vue'
import SearchDialog from './SearchDialog.vue'
import { matchesCombo } from '@/lib/shortcut'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const nav = [
  { path: '/', label: '仪表盘', icon: 'i-grid' },
  { path: '/weather', label: '天气', icon: 'i-sun' },
  { path: '/schedule', label: '日程', icon: 'i-cal' },
  { path: '/todo', label: '待办', icon: 'i-check', badge: 'todo' },
  { path: '/pomodoro', label: '番茄钟', icon: 'i-timer' },
  { path: '/feed', label: '信息流', icon: 'i-rss', badge: 'feed' },
  { path: '/parcel', label: '快递', icon: 'i-box' },
  { path: '/mail', label: '邮件', icon: 'i-mail' }
]

const title = computed(() => (route.meta.title as string) || '效率工具集')
/** 外观设置里的「始终展开 / 可折叠」：关闭后侧栏收为图标条 */
const sidebarExpand = computed(() => store.settings?.appearance?.sidebarExpand !== false)

/** 侧栏折叠开关：与设置页「外观 › 侧边栏」同一个配置项，点哪边都同步 */
async function toggleSidebar() {
  const base: AppearanceSetting = store.settings?.appearance ?? {
    theme: '浅色', accent: '#0f766e', font: '小', sidebarExpand: true
  }
  try {
    await store.saveSettings({ appearance: { ...base, sidebarExpand: !sidebarExpand.value } })
  } catch (e) {
    log.exception('shell.sidebar', e)
  }
}
/** 全局搜索弹窗：顶栏点击或 Ctrl/Cmd+K 唤起 */
const showSearch = ref(false)

/* ---------- 自绘标题栏：窗口按钮与最大化状态 ---------- */
const maximized = ref(false)
let offMaximized: (() => void) | null = null
let offNavigate: (() => void) | null = null

function minimizeWindow() {
  if (!hasBridge()) return
  void call(() => bridge().window.minimize(), true)
}
async function toggleMaxWindow() {
  if (!hasBridge()) return
  const next = await call(() => bridge().window.toggleMaximize(), false)
  maximized.value = !!next
}
function closeWindow() {
  if (!hasBridge()) return
  void call(() => bridge().window.close(), true)
}

function onGlobalKey(e: KeyboardEvent) {
  if (showSearch.value) return
  const combo = store.settings?.shortcuts?.search || 'Ctrl+K'
  if (!matchesCombo(e, combo)) return
  e.preventDefault()
  showSearch.value = true
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKey)
  if (!hasBridge()) return
  void call(() => bridge().window.isMaximized(), false).then((v) => { maximized.value = !!v })
  offMaximized = bridge().onWindowMaximized((v) => { maximized.value = v })
  // 托盘菜单跳转：主进程发路径，渲染层只做路由切换
  offNavigate = bridge().onNavigate((to) => { void router.push(to) })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
  if (offMaximized) { offMaximized(); offMaximized = null }
  if (offNavigate) { offNavigate(); offNavigate = null }
})

function badgeOf(item: { badge?: string }): number {
  if (item.badge === 'todo') return store.pendingCount
  if (item.badge === 'feed') return store.feedUnread
  return 0
}
</script>

<template>
  <Icons />
  <div class="app-shell" :class="{ 'shell-compact': !sidebarExpand }">
    <aside class="sidebar" aria-label="主导航">
      <div class="brand">
        <span class="brand-mark"><svg viewBox="0 0 24 24"><use href="#i-grid"/></svg></span>
        <span class="brand-text">效率工具集</span>
        <n-button
          class="sidebar-toggle"
          size="tiny"
          quaternary
          circle
          :title="sidebarExpand ? '折叠侧边栏' : '展开侧边栏'"
          :aria-label="sidebarExpand ? '折叠侧边栏' : '展开侧边栏'"
          :aria-expanded="sidebarExpand"
          @click="toggleSidebar"
        >
          <template #icon>
            <svg viewBox="0 0 24 24"><use :href="sidebarExpand ? '#i-chev-l' : '#i-chev-r'" /></svg>
          </template>
        </n-button>
      </div>
      <nav class="nav">
        <n-scrollbar style="height:100%">
          <div class="nav-inner">
            <a v-for="item in nav" :key="item.path" class="nav-item" :class="{ active: route.path === item.path }" :href="'#' + item.path" :title="item.label">
              <svg><use :href="'#' + item.icon"/></svg><span>{{ item.label }}</span>
              <span v-if="badgeOf(item)" class="nav-count">{{ badgeOf(item) }}</span>
            </a>
            <div class="nav-section">系统</div>
            <a class="nav-item" :class="{ active: route.path === '/settings' }" href="#/settings" title="设置"><svg><use href="#i-gear"/></svg><span>设置</span></a>
          </div>
        </n-scrollbar>
      </nav>
      <div class="sidebar-footer">
        <div class="local-status" :title="'本地存储正常'"><span class="status-dot"></span><span class="local-status-text">本地存储正常</span></div>
        <div class="sidebar-footnote">{{ store.runtime ? "SQLite · " + store.runtime.db.split(/[\\/]/).pop() : "正在连接本地库" }}</div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <button type="button" class="search-box" aria-label="全局搜索（Ctrl K）" @click="showSearch = true">
          <svg><use href="#i-search"/></svg>
          <span class="search-placeholder">搜索任务、日程、邮件、文章、包裹…</span>
          <n-text depth="3" class="search-kbd">Ctrl K</n-text>
        </button>
        <div class="top-actions">
          <div class="win-controls">
            <n-button class="win-btn" size="tiny" quaternary aria-label="最小化" title="最小化" @click="minimizeWindow">
              <template #icon><svg viewBox="0 0 24 24"><use href="#i-win-min" /></svg></template>
            </n-button>
            <n-button class="win-btn" size="tiny" quaternary :aria-label="maximized ? '还原' : '最大化'" :title="maximized ? '还原' : '最大化'" @click="toggleMaxWindow">
              <template #icon><svg viewBox="0 0 24 24"><use :href="maximized ? '#i-win-restore' : '#i-win-max'" /></svg></template>
            </n-button>
            <n-button class="win-btn" size="tiny" quaternary type="error" aria-label="关闭" title="关闭" @click="closeWindow">
              <template #icon><svg viewBox="0 0 24 24"><use href="#i-win-close" /></svg></template>
            </n-button>
          </div>
        </div>
      </header>
      <main class="content">
        <n-scrollbar style="height:100%">
          <div class="content-inner">
            <div class="page-head">
              <div><h1>{{ title }}</h1><p class="page-sub"><slot name="subtitle">数据保存在本机 SQLite 数据库</slot></p></div>
              <div class="head-actions"><slot name="actions" /></div>
            </div>
            <slot />
          </div>
        </n-scrollbar>
      </main>
    </div>
    <SearchDialog v-model:show="showSearch" />
  </div>
</template>
