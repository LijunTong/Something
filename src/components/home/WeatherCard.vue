<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NSpin, NEmpty, NButton } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { WeatherCity, WeatherData } from '@/types/api'

const router = useRouter()
const cities = ref<WeatherCity[]>([])
const currentId = ref('')
const data = ref<WeatherData | null>(null)
const loading = ref(false)

const unit = ref<'C' | 'F'>('C')

function temp(c: number | undefined): string {
  if (c == null || !Number.isFinite(c)) return '—'
  return String(unit.value === 'F' ? Math.round(c * 9 / 5 + 32) : Math.round(c))
}

const chips = computed(() => cities.value.slice(0, 3))
const precip = computed(() => {
  const list = data.value?.hourly ?? []
  const head = list.slice(0, 1)[0]
  return head ? head.pop + '%' : '—'
})
const rainBars = computed(() => {
  const list = data.value?.hourly ?? []
  return list.slice(0, 3).map((h) => ({ key: h.time, pop: Number(h.pop) || 0, height: Math.max(4, Math.min(26, Math.round((Number(h.pop) || 0) / 100 * 26))) }))
})
const iconHref = computed(() => {
  const cond = String(data.value?.now.cond || '')
  if (cond.indexOf('雨') >= 0) return '#i-rain'
  if (cond.indexOf('雷') >= 0) return '#i-thunder'
  if (cond.indexOf('晴') >= 0) return '#i-sun'
  if (cond.indexOf('阴') >= 0) return '#i-cloud'
  return '#i-partly'
})

async function load(id?: string) {
  if (!hasBridge()) return
  loading.value = true
  try {
    if (!cities.value.length) cities.value = await call(() => bridge().weather.cities(), [] as WeatherCity[])
    const target = id || currentId.value || (cities.value.find((c) => c.home) || cities.value[0] || { id: '' }).id
    if (!target) return
    currentId.value = target
    const [w, s] = await Promise.all([
      call(() => bridge().weather.fetch({ cityId: target }), null as unknown as WeatherData),
      call(() => bridge().settings.get('weather'), null)
    ])
    if (w) data.value = w
    const u = (s as { unit?: 'C' | 'F' } | null)?.unit
    if (u === 'F' || u === 'C') unit.value = u
  } catch (e) {
    log.exception('home.weather', e)
  } finally {
    loading.value = false
  }
}

function pick(c: WeatherCity) {
  if (c.id === currentId.value) return
  currentId.value = c.id
  void load(c.id)
}

function open() { void router.push('/weather') }
onMounted(() => { void load() })
const refreshTick = useHomeCardRefresh('weather')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-clickable hc-card hc-card-weather" @click="open">
    <template #header>
      <div class="hc-head">
        <span>天气<template v-if="data?.name"> · {{ data.name }}</template></span>
        <n-tag size="tiny">{{ data?.fromCache ? '本地缓存' : '已更新' }}</n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <n-button size="tiny" quaternary @click.stop="open">查看详情</n-button>
          <HomeCardMenu module="weather" />
        </div>
      </template>

    <n-spin :show="loading">
      <div class="hc-wx-chips">
        <n-button
          v-for="c in chips"
          :key="c.id"
          size="tiny"
          :type="c.id === currentId ? 'primary' : 'default'"
          :ghost="c.id !== currentId"
          @click.stop="pick(c)"
        >{{ c.name }}</n-button>
      </div>

      <n-empty v-if="!data" size="small" description="暂无天气数据" />
      <template v-else>
        <div class="hc-wx-main">
          <svg class="hc-wx-icon" viewBox="0 0 24 24"><use :href="iconHref" /></svg>
          <div>
            <div class="hc-wx-temp">{{ temp(data.now.temp) }}<sub>°</sub></div>
            <div class="hc-muted">{{ data.now.cond }} · 体感 {{ temp(data.now.feel) }}°</div>
          </div>
        </div>
        <div class="hc-wx-facts">
          <div><span class="hc-muted">湿度</span><strong>{{ data.now.humidity }}%</strong></div>
          <div><span class="hc-muted">风速</span><strong>{{ data.now.wind }}</strong></div>
          <div><span class="hc-muted">降水</span><strong>{{ precip }}</strong></div>
        </div>
        <div class="hc-rain">
          <span class="hc-muted">未来 3 小时</span>
          <i v-for="b in rainBars" :key="b.key" :style="{ height: b.height + 'px' }" :title="b.pop + '%'"></i>
        </div>
      </template>
    </n-spin>

    <template #footer>
      <span class="hc-muted">多城市切换与逐小时预报 · 点击进入天气页</span>
    </template>
  </n-card>
</template>