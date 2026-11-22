<script setup lang="ts">
import { computed, onMounted, ref, watch, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NMenu } from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import Shell from '@/components/Shell.vue'
import AppearancePanel from '@/components/settings/AppearancePanel.vue'
import NotifyPanel from '@/components/settings/NotifyPanel.vue'
import WindowPanel from '@/components/settings/WindowPanel.vue'
import DataPanel from '@/components/settings/DataPanel.vue'
import ShortcutPanel from '@/components/settings/ShortcutPanel.vue'
import AboutPanel from '@/components/settings/AboutPanel.vue'
import { useSettings } from '@/composables/useSettings'
import '@/styles/settings.css'

/**
 * 设置页只承载「应用级」配置。
 * 模块自身的配置（天气数据源、邮箱账户、订阅源）放在各自页面的右侧抽屉里；
 * 首页卡片显隐在首页「卡片设置」与卡片右上角菜单里。
 */
const PANELS: Record<string, { label: string; comp: unknown }> = {
  appearance: { label: '外观', comp: AppearancePanel },
  notify: { label: '通知', comp: NotifyPanel },
  window: { label: '窗口与启动', comp: WindowPanel },
  data: { label: '数据与存储', comp: DataPanel },
  shortcut: { label: '快捷键', comp: ShortcutPanel },
  about: { label: '关于', comp: AboutPanel }
}

/** 旧深链（?panel=weather / mod:todo 等）跳到对应模块页 */
const LEGACY_ROUTES: Record<string, string> = {
  weather: '/weather',
  weatherSource: '/weather',
  mail: '/mail',
  feed: '/feed'
}
const MODULE_ROUTES: Record<string, string> = {
  todo: '/todo',
  schedule: '/schedule',
  pomodoro: '/pomodoro',
  feed: '/feed',
  parcel: '/parcel',
  mail: '/mail',
  notice: '/'
}

const route = useRoute()
const router = useRouter()
const { load } = useSettings()
// 默认落在「外观」：设置页最常改的是主题与侧边栏
const active = ref<string>('appearance')

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
      { label: '窗口与启动', key: 'window', icon: icon('i-gear') },
      { label: '数据与存储', key: 'data', icon: icon('i-database') },
      { label: '快捷键', key: 'shortcut', icon: icon('i-key') },
      { label: '关于', key: 'about', icon: icon('i-info') }
    ]
  }
])

const currentLabel = computed(() => PANELS[active.value]?.label || '设置')

function applyQuery() {
  const p = String(route.query.panel || '')
  if (!p) return
  if (PANELS[p]) { active.value = p; return }
  if (LEGACY_ROUTES[p]) { void router.replace(LEGACY_ROUTES[p]); return }
  if (p.startsWith('mod:')) {
    const target = MODULE_ROUTES[p.slice(4)]
    if (target) void router.replace(target)
  }
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
      当前面板：{{ currentLabel }} · 配置只保存在本机
    </template>

    <div class="set-layout">
      <n-card class="set-nav" size="small" :content-style="'padding:6px'">
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
        <WindowPanel v-else-if="active === 'window'" />
        <DataPanel v-else-if="active === 'data'" />
        <ShortcutPanel v-else-if="active === 'shortcut'" />
        <AboutPanel v-else-if="active === 'about'" />
        <n-card v-else size="small" title="未选择面板">
          <span class="set-muted">从左侧选择一个设置面板。</span>
        </n-card>
        <!-- 页脚提示放在内容列里：跟着卡片同宽同左沿，不再自带宽窄（原先是第三条右轨） -->
        <div class="set-footbar">
          <svg viewBox="0 0 24 24"><use href="#i-warn" /></svg>
          <span>本应用不提供账户体系与云同步，所有数据仅保存在本机。请定期备份，卸载或清除浏览器数据可能导致数据丢失。</span>
        </div>
      </section>
    </div>
  </Shell>
</template>
