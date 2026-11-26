<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NButton, NSwitch, useMessage } from 'naive-ui'
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { useSettings } from '@/composables/useSettings'
import { useWidgets } from '@/composables/useWidgets'
import { CARD_META, type CardKey } from '@/composables/useHomeCards'
import { call } from '@/lib/ipc'
import type { WidgetItem } from '@/types/api'
import '@/styles/settings.css'

/**
 * 桌面挂件：管理已经钉到桌面的卡片。
 * 挂件本身是独立窗口（主进程 electron/widget.cjs 持有），这里只做增删与置顶，
 * 位置/大小由挂件窗口自己写回设置，页面不改坐标。
 */
const { settings, save } = useSettings()
const widgets = useWidgets()
const message = useMessage()

const transparent = computed(() => settings.value.widgets?.useTransparent !== false)

function cardLabel(key: string): string {
  return CARD_META[key as CardKey] ? CARD_META[key as CardKey].label : key
}

/** 透明浮窗在个别显卡/远程桌面下会出现黑底，关掉后改用不透明底色更稳 */
async function setTransparent(v: boolean) {
  try {
    await save('widgets', { items: settings.value.widgets?.items || [], useTransparent: v })
    message.success(v ? '挂件使用透明背景' : '挂件改用不透明背景')
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function setOnTop(it: WidgetItem, v: boolean) {
  try {
    await widgets.patchWidget(it.id, { alwaysOnTop: v })
    message.success(v ? '「' + cardLabel(it.card) + '」已固定在最前层' : '「' + cardLabel(it.card) + '」已跟随窗口层叠')
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

async function removeOne(it: WidgetItem) {
  const ok = await widgets.unpin(it.card as CardKey)
  if (ok) message.info('已收回「' + cardLabel(it.card) + '」')
  else message.error('收回失败，请重试')
}

async function removeAll() {
  const ok = await widgets.unpinAll()
  if (ok) message.info('已收回全部桌面卡片')
  else message.error('收回失败，请重试')
}

async function showAllWindows() {
  try {
    // 返回实际显示出来的窗口数（0 表示当前没有挂件窗口）
    const shown = await call(() => window.api.widget.showAll(), 0)
    message.success(shown ? '已显示 ' + shown + ' 个挂件' : '没有可显示的挂件')
  } catch (e) {
    message.error('显示失败：' + ((e as Error).message || '未知错误'))
  }
}

async function hideAllWindows() {
  try {
    const hidden = await call(() => window.api.widget.hideAll(), 0)
    message.success(hidden ? '已隐藏 ' + hidden + ' 个挂件' : '没有可隐藏的挂件')
  } catch (e) {
    message.error('隐藏失败：' + ((e as Error).message || '未知错误'))
  }
}
</script>

<template>
  <n-card size="small" title="桌面挂件">
    <template #header-extra>
      <!-- 这里不用首页的 hc-status（样式在 home.css，设置页没有加载），走设置页自己的次要文字类 -->
      <span class="set-muted">{{ widgets.count.value ? widgets.count.value + ' 张在桌面' : '暂无' }}</span>
    </template>

    <SectionTitle title="窗口形态" />
    <div class="set-field">
      <span class="set-field-key">
        透明背景
        <small class="set-hint">关掉后挂件改用纯色底；远程桌面或个别显卡上透明窗口发黑时用它</small>
      </span>
      <n-switch :value="transparent" @update:value="setTransparent" />
    </div>

    <SectionTitle title="已钉到桌面的卡片" />
    <div v-if="!widgets.count.value" class="set-list">
      <div class="set-list-row">
        <span class="set-list-main">
          <strong>还没有卡片在桌面</strong>
          <small>在仪表盘把卡片拖到窗口外松手，或点卡片右上角菜单里的「钉到桌面」</small>
        </span>
      </div>
    </div>
    <div v-else class="set-list">
      <div v-for="it in widgets.items.value" :key="it.id" class="set-list-row">
        <span class="set-list-main">
          <strong>{{ cardLabel(it.card) }}</strong>
          <small>{{ it.alwaysOnTop ? '固定在最前层，切到别的应用也看得见' : '跟随窗口层叠，所有窗口最小化时一起隐藏' }}</small>
        </span>
        <div class="set-inline">
          <n-switch :value="it.alwaysOnTop" @update:value="(v: boolean) => setOnTop(it, v)" />
          <n-button size="tiny" @click="removeOne(it)">收回</n-button>
        </div>
      </div>
    </div>

    <div class="set-actions">
      <n-button size="small" :disabled="!widgets.count.value" @click="showAllWindows">全部显示</n-button>
      <n-button size="small" :disabled="!widgets.count.value" @click="hideAllWindows">全部隐藏</n-button>
      <n-button size="small" :disabled="!widgets.count.value" @click="removeAll">全部收回</n-button>
      <span class="set-muted">最多同时钉 {{ widgets.maxCount.value }} 张。</span>
    </div>

    <p class="set-note">
      「常驻」指随应用启动自动恢复、不占任务栏、可固定在最前层。按 Win+D 或点击「显示桌面」时挂件会跟着桌面一起收起，
      这不是贴壁纸层的实现；隐藏首页卡片不会收回桌面那份，两者互不影响。
    </p>
  </n-card>
</template>
