<script setup lang="ts">
import { computed, onMounted, ref, watch, h } from 'vue'
import { useRoute } from 'vue-router'
import { NMenu, NTag } from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import Shell from '@/components/Shell.vue'
import AppearancePanel from '@/components/settings/AppearancePanel.vue'
import NotifyPanel from '@/components/settings/NotifyPanel.vue'
import DataPanel from '@/components/settings/DataPanel.vue'
import MailAccountsPanel from '@/components/settings/MailAccountsPanel.vue'
import FeedPanel from '@/components/settings/FeedPanel.vue'
import ShortcutPanel from '@/components/settings/ShortcutPanel.vue'
import AboutPanel from '@/components/settings/AboutPanel.vue'
import WeatherSourcePanel from '@/components/settings/WeatherSourcePanel.vue'
import ModulePanel from '@/components/settings/ModulePanel.vue'
import { useSettings } from '@/composables/useSettings'
import '@/styles/settings.css'

/** 左侧导航：设计书的 7 个通用面板 + 效率模块开关（天气面板已合并模块开关与数据源） */
const PANELS: Record<string, { label: string; comp: unknown }> = {
  appearance: { label: '外观', comp: AppearancePanel },
  notify: { label: '通知', comp: NotifyPanel },
  data: { label: '数据与存储', comp: DataPanel },
  mail: { label: '邮箱账户', comp: MailAccountsPanel },
  feed: { label: '订阅源', comp: FeedPanel },
  shortcut: { label: '快捷键', comp: ShortcutPanel },
  about: { label: '关于', comp: AboutPanel },
  weather: { label: '天气', comp: WeatherSourcePanel }
}

/** 模块项图标与左侧主导航完全一致（i-grid / i-sun / i-cal / i-check / i-timer / i-rss / i-box / i-mail） */
const MODULES = [
  { key: 'dashboard', label: '仪表盘', icon: 'i-grid' },
  { key: 'schedule', label: '日程', icon: 'i-cal' },
  { key: 'todo', label: '待办', icon: 'i-check' },
  { key: 'pomodoro', label: '番茄钟', icon: 'i-timer' },
  { key: 'feed', label: '信息流', icon: 'i-rss' },
  { key: 'parcel', label: '快递', icon: 'i-box' },
  { key: 'mail', label: '邮件', icon: 'i-mail' }
] as const

const route = useRoute()
const { load } = useSettings()
const active = ref<string>('data')

function icon(name: string) {
  return () => h('svg', { class: 'set-menu-icon', viewBox: '0 0 24 24' }, [h('use', { href: '#' + name })])
}

const menuOptions = computed<MenuOption[]>(() => [
  {
    type: 'group',
    label: '通用设置',
    key: 'g-common',
    children: [
      { label: '外观', key: 'appearance', icon: icon('i-palette') },
      { label: '通知', key: 'notify', icon: icon('i-bell') },
      { label: '数据与存储', key: 'data', icon: icon('i-database') },
      { label: '邮箱账户', key: 'mail', icon: icon('i-mail') },
      { label: '订阅源', key: 'feed', icon: icon('i-rss') },
      { label: '快捷键', key: 'shortcut', icon: icon('i-key') },
      { label: '关于', key: 'about', icon: icon('i-info') }
    ]
  },
  {
    type: 'group',
    label: '效率模块',
    key: 'g-module',
    children: [
      { label: '天气', key: 'weather', icon: icon('i-sun') },
      ...MODULES.map((m) => ({ label: m.label, key: 'mod:' + m.key, icon: icon(m.icon) }))
    ]
  }
])

const currentLabel = computed(() => {
  if (active.value.startsWith('mod:')) {
    const key = active.value.slice(4)
    return MODULES.find((m) => m.key === key)?.label || '模块'
  }
  return PANELS[active.value]?.label || '设置'
})

/** 兼容旧链接：?panel=weatherSource 与 ?panel=weather 都落到合并后的天气面板 */
function applyQuery() {
  const p = String(route.query.panel || '')
  if (!p) return
  if (p === 'weatherSource') { active.value = 'weather'; return }
  if (PANELS[p]) { active.value = p; return }
  if (p.startsWith('mod:') && MODULES.some((m) => m.key === p.slice(4))) { active.value = p; return }
  if (MODULES.some((m) => m.key === p)) active.value = 'mod:' + p
}

watch(() => route.query.panel, applyQuery)
onMounted(async () => {
  applyQuery()
  await load(true)
})
</script>

<template>
  <Shell>
    <template #subtitle>
      所有配置保存在本机，不会上传到任何服务器 · 当前面板：{{ currentLabel }}
    </template>
    <template #actions>
      <n-tag size="small" type="success">本地 SQLite</n-tag>
      <n-tag size="small">全部配置保存在本机</n-tag>
    </template>

    <div class="set-layout">
      <n-card class="set-nav" size="small" :content-style="'padding:4px'">
        <n-menu
          v-model:value="active"
          :options="menuOptions"
          :indent="14"
          :root-indent="10"
        />
      </n-card>

      <section class="set-content">
        <AppearancePanel v-if="active === 'appearance'" />
        <NotifyPanel v-else-if="active === 'notify'" />
        <DataPanel v-else-if="active === 'data'" />
        <MailAccountsPanel v-else-if="active === 'mail'" />
        <FeedPanel v-else-if="active === 'feed'" />
        <ShortcutPanel v-else-if="active === 'shortcut'" />
        <AboutPanel v-else-if="active === 'about'" />
        <WeatherSourcePanel v-else-if="active === 'weather'" />
        <ModulePanel
          v-else-if="active.startsWith('mod:')"
          :module-key="active.slice(4)"
          :label="currentLabel"
        />
        <n-card v-else size="small" title="未选择面板">
          <span class="set-muted">从左侧选择一个设置面板。</span>
        </n-card>
      </section>
    </div>

    <div class="set-footbar">
      <svg viewBox="0 0 24 24"><use href="#i-warn" /></svg>
      <span>本应用不提供账户体系与云同步，所有数据仅保存在本机。请定期备份，卸载或清除浏览器数据可能导致数据丢失。</span>
    </div>
  </Shell>
</template>
