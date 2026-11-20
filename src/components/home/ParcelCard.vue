<script setup lang="ts">
import { homeRefreshToken } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NEmpty, NSpin, NButton } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { ParcelRow } from '@/types/api'

const router = useRouter()
const rows = ref<ParcelRow[]>([])
const loading = ref(false)
const refreshedAt = ref(0)

function dateText(ts: number | null): string {
  if (!ts) return '待更新'
  const d = new Date(ts)
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
}
const list = computed(() => rows.value.slice(0, 2))
const pendingPickup = computed(() => rows.value.filter((r) => r.status === '待取件').length)

async function load() {
  if (!hasBridge()) return
  loading.value = true
  try {
    rows.value = await call(() => bridge().parcel.list({ archived: false }), [] as ParcelRow[])
    refreshedAt.value = Date.now()
  } catch (e) {
    log.exception('home.parcel', e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(homeRefreshToken, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-parcel">
    <template #header>
      <div class="hc-head">
        <span>快递</span>
        <n-tag size="tiny" :type="pendingPickup ? 'warning' : 'default'">{{ pendingPickup ? pendingPickup + ' 个待取件' : rows.length + ' 个在途' }}</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <n-button size="tiny" quaternary @click="router.push('/parcel')">+ 添加单号</n-button>
          <HomeCardMenu module="parcel" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty v-if="!list.length" size="small" description="没有在途包裹" />
      <div v-for="p in list" :key="p.id" class="hc-parcel-row">
        <svg class="hc-ico" viewBox="0 0 24 24"><use :href="p.status === '待取件' ? '#i-box' : '#i-truck'" /></svg>
        <span class="hc-parcel-main">
          <strong>{{ p.company }}</strong>
          <small class="hc-muted">
            {{ p.status === '待取件' ? (p.pickupCode ? '取件码 ' + p.pickupCode : '待取件') : '预计 ' + dateText(p.etaAt) + ' 送达' }}
            <template v-if="p.station"> · {{ p.station }}</template>
          </small>
        </span>
        <n-tag size="tiny" :type="p.status === '待取件' ? 'warning' : 'default'">{{ p.status }}</n-tag>
      </div>
    </n-spin>

    <template #footer>
      <span class="hc-muted">最近刷新 {{ refreshedAt ? new Date(refreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—' }} · 数据已缓存至本机</span>
    </template>
  </n-card>
</template>