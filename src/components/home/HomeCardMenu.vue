<script setup lang="ts">
import { NDropdown, NButton } from 'naive-ui'
import { useMessage } from 'naive-ui'
import { useHomeCards, CARD_META, type CardKey } from '@/composables/useHomeCards'

const props = defineProps<{ module: CardKey }>()
const { setVisible } = useHomeCards()
const message = useMessage()

function handle(key: string) {
  if (key === 'hide') {
    void setVisible(props.module, false).then(() => {
      message.info('已隐藏「' + CARD_META[props.module].label + '」卡片，可在「卡片设置」里恢复')
    })
  }
}
</script>

<template>
  <!-- 外层 span 阻断冒泡：天气卡整卡可点击进入详情，菜单点击不能把用户带走 -->
  <span class="hc-menu-wrap" @click.stop>
    <n-dropdown
      trigger="click"
      placement="bottom-end"
      :options="[{ label: '隐藏此卡片', key: 'hide' }]"
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
