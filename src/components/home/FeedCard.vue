<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NEmpty, NSpin, NButton, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { FeedItem, FeedSource } from '@/types/api'

const router = useRouter()
const message = useMessage()
const items = ref<FeedItem[]>([])
const sourceCount = ref(0)
const loading = ref(false)

// 卡片按行高只能放几条：这里给 5 条，超出部分在卡片内容区内部滚动（home.css 已放开 overflow）
const CARD_ROWS = 5
const list = computed(() => items.value.slice(0, CARD_ROWS))

function ago(ts: number | null): string {
  if (!ts) return '时间未知'
  const min = Math.max(0, Math.floor((Date.now() - ts) / 60000))
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const hr = Math.floor(min / 60)
  return hr < 24 ? hr + ' 小时前' : Math.floor(hr / 24) + ' 天前'
}

async function load() {
  if (!hasBridge()) return
  loading.value = true
  try {
    const [list_, src] = await Promise.all([
      call(() => bridge().feed.items({ kind: 'unread' }), [] as FeedItem[]),
      call(() => bridge().feed.sources(), [] as FeedSource[])
    ])
    // 服务端已按未读过滤；这里再兜一层，读完的文章无论如何都不出现在卡片上
    items.value = list_.filter((i) => !i.read)
    sourceCount.value = src.length
  } catch (e) {
    log.exception('home.feed', e)
  } finally {
    loading.value = false
  }
}

async function later(item: FeedItem) {
  try {
    await call(() => bridge().feed.toggleLater(item.id))
    message.success('已加入稍后读')
    await load()
  } catch (e) {
    log.exception('home.feed.later', e)
    message.error('操作失败：' + ((e as Error).message || '未知错误'))
  }
}


onMounted(load)
const refreshTick = useHomeCardRefresh('feed')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-feed">
    <template #header>
      <div class="hc-head">
        <!-- 只有标题文字进信息流页，卡片其它区域不跳转 -->
        <n-button text size="small" @click="router.push('/feed')">信息流</n-button>
        <n-tag size="tiny" :type="items.length ? 'warning' : 'success'">未读 {{ items.length }}</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <HomeCardMenu module="feed" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty v-if="!list.length" size="small" description="没有未读文章" />
      <div
        v-for="item in list"
        :key="item.id"
        class="hc-feed-item hc-row-link"
        role="button"
        tabindex="0"
        @click="router.push({ path: '/feed', query: { focus: item.id } })"
        @keydown.enter="router.push({ path: '/feed', query: { focus: item.id } })"
      >
        <div class="hc-feed-row">
          <n-button class="hc-feed-title" text size="tiny" @click.stop="router.push({ path: '/feed', query: { focus: item.id } })">{{ item.title }}</n-button>
          <n-button size="tiny" quaternary @click.stop="later(item)">稍后读</n-button>
        </div>
        <small class="hc-muted">{{ item.sourceTitle || '来源未知' }} · {{ ago(item.publishedAt) }}</small>
      </div>
    </n-spin>

    <template #footer>
      <span class="hc-muted">已订阅 {{ sourceCount }} 个来源 · 抓取结果只做本地缓存</span>
    </template>
  </n-card>
</template>