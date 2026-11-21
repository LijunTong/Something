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

const list = computed(() => items.value.slice(0, 3))

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
    items.value = list_
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
        <span>信息流</span>
        <n-tag size="tiny" :type="items.length ? 'warning' : 'success'">未读 {{ items.length }}</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <n-button size="tiny" quaternary @click="router.push('/feed')">打开信息流</n-button>
          <HomeCardMenu module="feed" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty v-if="!list.length" size="small" description="没有未读文章" />
      <div v-for="item in list" :key="item.id" class="hc-feed-item">
        <div class="hc-feed-row">
          <n-button class="hc-feed-title" text size="tiny" @click="router.push('/feed')">{{ item.title }}</n-button>
          <n-button size="tiny" quaternary @click="later(item)">稍后读</n-button>
        </div>
        <small class="hc-muted">{{ item.sourceTitle || '来源未知' }} · {{ ago(item.publishedAt) }}</small>
      </div>
    </n-spin>

    <template #footer>
      <span class="hc-muted">已订阅 {{ sourceCount }} 个来源 · 抓取结果只做本地缓存</span>
    </template>
  </n-card>
</template>