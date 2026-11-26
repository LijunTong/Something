<script setup lang="ts">
import { computed } from 'vue'
import { NDropdown, NButton, NTag, NTooltip, useMessage } from 'naive-ui'
import { useHomeCards, CARD_META, type CardKey } from '@/composables/useHomeCards'
import { triggerHomeRefresh } from '@/composables/useHomeRefresh'
import { useWidgets } from '@/composables/useWidgets'
import { inWidget } from '@/lib/widgetContext'

// actions：卡片自己的操作项（新增待办、新增单号、时长设置……），点击后在卡片所在页弹窗完成，不跳模块页
const props = defineProps<{ module: CardKey; actions?: Array<{ label: string; key: string }> }>()
const emit = defineEmits<{ (e: 'action', key: string): void }>()
const { setVisible } = useHomeCards()
const widgets = useWidgets()
const message = useMessage()

// 挂件窗口里这张卡已经在桌面上了，钉/藏都没有意义，菜单只留刷新与收回
const inWidgetView = inWidget()
const pinned = computed(() => widgets.isPinned(props.module))

const options = computed(() => {
  const items: any[] = []
  if (inWidgetView) {
    items.push({ label: '刷新', key: 'refresh' }, { label: '收回桌面卡片', key: 'unpin' })
    return items
  }
  if (props.actions && props.actions.length) {
    items.push(...props.actions)
    items.push({ type: 'divider', key: 'd-card-actions' })
  }
  items.push({
    label: pinned.value ? '收回桌面卡片' : '钉到桌面',
    key: pinned.value ? 'unpin' : 'pin'
  })
  items.push({ label: '刷新', key: 'refresh' }, { label: '隐藏此卡片', key: 'hide' })
  return items
})

function handle(key: string) {
  // 只重载本卡：走单卡令牌，不牵动其他卡片，也不改首页「数据更新于」时间
  if (key === 'refresh') { triggerHomeRefresh(props.module); return }
  if (key === 'pin') {
    void widgets.pin(props.module).then((ok) => {
      if (ok) message.success(CARD_META[props.module].label + '已钉到桌面，位置可以用右键菜单里的「总在最前」调整')
    })
    return
  }
  if (key === 'unpin') {
    void widgets.unpin(props.module).then((ok) => {
      if (ok) message.info('已收回「' + CARD_META[props.module].label + '」桌面卡片')
    })
    return
  }
  if (key === 'hide') {
    void setVisible(props.module, false).then(() => {
      message.info('已隐藏「' + CARD_META[props.module].label + '」卡片，可在「卡片设置」里恢复')
    })
    return
  }
  emit('action', key)
}
</script>

<template>
  <!-- 外层 span 阻断冒泡：菜单点击不能把用户带走 -->
  <span class="hc-menu-wrap" @click.stop>
    <!-- 已钉到桌面：常驻标记，点一下收回（挂件本身不用这个标记） -->
    <n-tooltip v-if="pinned && !inWidgetView" trigger="hover">
      <template #trigger>
        <n-tag class="hc-pin-tag" size="tiny" type="success" :bordered="false" @click="handle('unpin')">桌面</n-tag>
      </template>
      这张卡已在桌面常驻，点击收回
    </n-tooltip>
    <n-dropdown
      trigger="click"
      placement="bottom-end"
      :options="options"
      @select="handle"
    >
      <n-button size="tiny" quaternary circle :title="'卡片设置：' + CARD_META[module].label" aria-label="卡片菜单">
        <template #icon>
          <svg viewBox="0 0 24 24"><use href="#i-more" /></svg>
        </template>
      </n-button>
    </n-dropdown>
  </span>
</template>
