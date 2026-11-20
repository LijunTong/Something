<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NInput, NBadge, NButton, NTag, NScrollbar } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { log } from '@/lib/logger'
import type { AppearanceSetting } from '@/types/api'
import Icons from './Icons.vue'

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
const searchText = computed({ get: () => '', set: () => {} })

function badgeOf(item: { badge?: string }): number {
  if (item.badge === 'todo') return store.pendingCount
  if (item.badge === 'feed') return store.feedUnread
  return 0
}

function onSearch(v: string) {
  const q = v.trim().toLowerCase()
  if (!q) return
  const hit = store.todos.find((t) => t.title.toLowerCase().includes(q))
  if (hit) { router.push('/todo') } 
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
        <div class="local-status"><span class="status-dot"></span>本地存储正常</div>
        <div class="sidebar-footnote">{{ store.runtime ? "SQLite · " + store.runtime.db.split(/[\\/]/).pop() : "正在连接本地库" }}</div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="search-box" role="search">
          <svg><use href="#i-search"/></svg>
          <input type="search" aria-label="全局搜索" placeholder="搜索任务、日程、邮件、文章、包裹…" @change="onSearch(($event.target as HTMLInputElement).value)" />
          <kbd>Ctrl K</kbd>
        </div>
        <div class="top-actions">
          <n-button size="small" quaternary @click="router.push('/todo')">快捷添加</n-button>
          <div class="os-space" aria-hidden="true"></div>
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
  </div>
</template>
