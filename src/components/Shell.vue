<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NScrollbar } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { log } from '@/lib/logger'
import { bridge, call, hasBridge } from '@/lib/ipc'
import type { AppearanceSetting } from '@/types/api'
import Icons from './Icons.vue'
import BrandMark from './BrandMark.vue'
import NotifyHost from './NotifyHost.vue'
import SearchDialog from './SearchDialog.vue'
import { matchesCombo } from '@/lib/shortcut'
import { PARCEL_ENABLED } from '@/lib/features'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const navAll = [
  { path: '/', label: '仪表盘', icon: 'i-grid' },
  { path: '/weather', label: '天气', icon: 'i-sun' },
  { path: '/schedule', label: '日程', icon: 'i-cal' },
  { path: '/todo', label: '待办', icon: 'i-check', badge: 'todo' },
  { path: '/pomodoro', label: '番茄钟', icon: 'i-timer' },
  { path: '/feed', label: '信息流', icon: 'i-rss', badge: 'feed' },
  { path: '/parcel', label: '快递', icon: 'i-box' },
  { path: '/mail', label: '邮件', icon: 'i-mail' }
]

/** 快递接口没有免费额度，入口先整体隐藏；见 src/lib/features.ts，改回 true 即恢复 */
const nav = navAll.filter((item) => PARCEL_ENABLED || item.path !== '/parcel')

/** 「系统」分区：通知属于应用级入口，排在设置之前 */
const sysNav = [
  { path: '/notice', label: '通知', icon: 'i-bell', badge: 'notice' },
  { path: '/settings', label: '设置', icon: 'i-gear' }
]

const title = computed(() => (route.meta.title as string) || '几件事')
/** 外观设置里的「始终展开 / 可折叠」：关闭后侧栏收为图标条 */
const sidebarExpand = computed(() => store.settings?.appearance?.sidebarExpand !== false)

/**
 * 全屏专注（?immersive=1）：整个外壳退化为单栏。
 * 不能只靠番茄钟页的 .pm-focus 覆盖层——它在 .workspace 的层叠上下文里（z-index:1），
 * 永远压不过 .sidebar（z-index:2），左侧必然露出菜单。
 */
const immersive = computed(() => route.query.immersive === '1')

/** 侧栏折叠开关：与设置页「外观 › 侧边栏」同一个配置项，点哪边都同步 */
async function toggleSidebar() {
  const base: AppearanceSetting = store.settings?.appearance ?? {
    theme: '浅色', accent: '#0f766e', font: '中', sidebarExpand: true
  }
  try {
    await store.saveSettings({ appearance: { ...base, sidebarExpand: !sidebarExpand.value } })
  } catch (e) {
    log.exception('shell.sidebar', e)
  }
}
/** 侧栏底部的版本号：取主进程 app.getVersion()，浏览器预览没有 runtime 时显示未连接 */
const versionText = computed(() => (store.runtime && store.runtime.version ? 'v' + store.runtime.version : '未连接'))
/** 全局搜索弹窗：顶栏图标或 Ctrl/Cmd+K 唤起 */
const showSearch = ref(false)
function goNotice() {
  void router.push('/notice')
}

/** 快捷主题切换：浅色 → 深色 → 跟随系统 三态循环，不覆盖其它外观项 */
const isDark = computed(() => {
  const mode = store.themeMode
  if (mode === '深色') return true
  if (mode !== '跟随系统') return false
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
})
const THEME_SEQ: Array<AppearanceSetting['theme']> = ['浅色', '深色', '跟随系统']
/** 当前档位的下一个档位（未知值按浅色处理） */
const nextTheme = computed<AppearanceSetting['theme']>(() => {
  const idx = THEME_SEQ.indexOf(store.themeMode)
  return THEME_SEQ[(idx < 0 ? 0 : idx + 1) % THEME_SEQ.length]
})
/** 图标表示当前档位：浅色=月亮（可切到深色）、深色=太阳、跟随系统=显示器 */
const themeIcon = computed(() => {
  if (store.themeMode === '跟随系统') return '#i-monitor'
  return isDark.value ? '#i-sun' : '#i-moon'
})
const themeTitle = computed(() => '主题：' + store.themeMode + '（点击切换到' + nextTheme.value + '）')
async function toggleTheme() {
  const base: AppearanceSetting = store.settings?.appearance ?? {
    theme: '浅色', accent: '#0f766e', font: '中', sidebarExpand: true
  }
  try {
    await store.saveSettings({ appearance: { ...base, theme: nextTheme.value } })
  } catch (e) {
    log.exception('shell.theme', e)
  }
}

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
  if (item.badge === 'notice') return store.noticeUnread
  return 0
}
</script>

<template>
  <Icons />
  <!-- 应用内通知浮层：订阅主进程 notify:event -->
  <NotifyHost />
  <div class="app-shell" :class="{ 'shell-compact': !sidebarExpand, 'shell-immersive': immersive }">
    <aside v-if="!immersive" class="sidebar" aria-label="主导航">
      <div class="brand">
        <span class="brand-mark"><BrandMark /></span>
        <span class="brand-text">几件事</span>
      </div>
      <nav class="nav">
        <n-scrollbar style="height:100%">
          <div class="nav-inner">
            <a v-for="item in nav" :key="item.path" class="nav-item" :class="{ active: route.path === item.path }" :href="'#' + item.path" :title="item.label">
              <svg><use :href="'#' + item.icon"/></svg><span>{{ item.label }}</span>
              <span v-if="badgeOf(item)" class="nav-count">{{ badgeOf(item) }}</span>
            </a>
            <div class="nav-section">系统</div>
            <a v-for="item in sysNav" :key="item.path" class="nav-item" :class="{ active: route.path === item.path }" :href="'#' + item.path" :title="item.label">
              <svg><use :href="'#' + item.icon"/></svg><span>{{ item.label }}</span>
              <span v-if="badgeOf(item)" class="nav-count">{{ badgeOf(item) }}</span>
            </a>
          </div>
        </n-scrollbar>
      </nav>
      <div class="sidebar-footer">
        <div class="local-status" :title="'本地存储正常'"><span class="status-dot"></span><span class="local-status-text">本地存储正常</span></div>
        <div class="sidebar-footnote sidebar-meta">
          <span class="sidebar-version" :title="store.runtime ? '版本 v' + store.runtime.version : '正在连接本地库'">{{ versionText }}</span>
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
      </div>
    </aside>
    <div class="workspace">
      <header v-if="!immersive" class="topbar">
        <div class="top-actions">
          <n-button class="win-btn" size="tiny" quaternary aria-label="搜索" title="搜索（Ctrl K）" @click="showSearch = true">
            <template #icon><svg viewBox="0 0 24 24"><use href="#i-search" /></svg></template>
          </n-button>
          <!-- 角标挂在按钮外层的定位盒上：放进 #icon 里会以图标为锚点，落不到按钮右上角 -->
          <span class="win-slot">
            <n-button class="win-btn" size="tiny" quaternary aria-label="通知" :title="store.noticeUnread ? '通知（' + store.noticeUnread + ' 条未读）' : '通知'" @click="goNotice">
              <template #icon><svg viewBox="0 0 24 24"><use href="#i-bell" /></svg></template>
            </n-button>
            <span v-if="store.noticeUnread" class="win-dot">{{ store.noticeUnread > 99 ? '99+' : store.noticeUnread }}</span>
          </span>
          <n-button class="win-btn" size="tiny" quaternary :aria-label="themeTitle" :title="themeTitle" @click="toggleTheme">
            <template #icon><svg viewBox="0 0 24 24"><use :href="themeIcon" /></svg></template>
          </n-button>
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
              <div v-if="$slots.actions" class="head-actions"><slot name="actions" /></div>
            </div>
            <slot />
          </div>
        </n-scrollbar>
      </main>
    </div>
    <SearchDialog v-model:show="showSearch" />
  </div>
</template>
