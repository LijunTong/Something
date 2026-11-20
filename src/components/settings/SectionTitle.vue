<script setup lang="ts">
import { NText } from 'naive-ui'

/**
 * 设置面板内的二级分区标签。
 * 卡片标题是 16px/600 的主层级，这里用 13px/600 作为次级：靠字号与 20px 间距分层，不与卡片标题同权。
 * 字号/字重/颜色全部由主题与 Naive 组件提供，组件内不写外观。
 */
defineProps<{ title: string }>()
</script>

<template>
  <div class="set-section">
    <n-text strong>{{ title }}</n-text>
  </div>
</template>
