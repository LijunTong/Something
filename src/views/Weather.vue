<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton, NButtonGroup, NInput, NTag, NSpin, NSkeleton, NAlert, NCard,
  NDrawer, NDrawerContent, NEmpty, NScrollbar, NSelect, NModal,
  NDescriptions, NDescriptionsItem, NConfigProvider, useMessage
} from 'naive-ui'
import Shell from '@/components/Shell.vue'
import WeatherSourcePanel from '@/components/settings/WeatherSourcePanel.vue'
import { call, bridge, plain, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { heroGradient as heroGradientOf } from '@/theme/sky'
import type { AllSettings, NotificationItem, WeatherCity, WeatherCitySearchResult, WeatherData, WeatherSetting } from '@/types/api'
import '@/styles/weather.css'

const message = useMessage()
const router = useRouter()

/* ---------- 状态 ---------- */
const cities = ref<WeatherCity[]>([])
const currentId = ref('')
const weather = ref<WeatherData | null>(null)
const loading = ref(false)
const offline = ref(!hasBridge())
const showDrawer = ref(false)
const showSource = ref(false)
const showAlerts = ref(false)
/** 城市搜索：GeoAPI 返回候选列表，用户点选后添加 */
const keyword = ref('')
const searching = ref(false)
const searched = ref(false)
const results = ref<WeatherCitySearchResult[]>([])
const addingId = ref('')
const unit = ref<'C' | 'F'>('C')
/** 自动刷新频率（分钟），来自设置，默认 5 */
const refreshMin = ref(5)
let refreshTimer: ReturnType<typeof setInterval> | null = null
const cityTemps = ref<Record<string, number>>({})
const notices = ref<NotificationItem[]>([])
/** 最近一次取数失败原因：接口报错时优先展示它，而不是笼统的「离线」提示 */
const lastError = ref('')

/* ---------- 计算 ---------- */
const currentCity = computed(() => cities.value.find((c) => c.id === currentId.value) ?? cities.value[0] ?? null)
const cityOptions = computed(() => cities.value.map((c) => ({ label: c.name + (c.home ? '（定位）' : ''), value: c.id })))
const wxNow = computed(() => weather.value?.now ?? null)
const fetchedAgo = computed(() => {
  const t = weather.value?.fetchedAt
  if (!t) return '刚刚'
  const min = Math.max(0, Math.floor((Date.now() - t) / 60000))
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  return h < 24 ? h + ' 小时前' : Math.floor(h / 24) + ' 天前'
})
const uvText = computed(() => {
  const u = wxNow.value?.uv
  if (u === '' || u == null) return '—'
  const n = Number(u)
  if (Number.isNaN(n)) return String(u)
  if (n <= 2) return '弱'
  if (n <= 5) return '中等'
  if (n <= 7) return '强'
  return '很强'
})
/** 数据来源标签：和风天气 / 其本地缓存；没有配置时显示未配置 */
const sourceLabel = computed(() => {
  const s = weather.value?.source
  if (s === 'qweather') return weather.value?.fromCache ? '和风天气 · 缓存' : '和风天气'
  if (s === 'cache') return '本地缓存'
  return '未配置数据源'
})
const sourceTagType = computed(() => (weather.value?.source === 'qweather' ? 'success' : 'warning'))
const fetchError = computed(() => lastError.value || weather.value?.error || '')

const aqiType = computed(() => {
  const n = weather.value?.aqi.num ?? 0
  if (n <= 50) return 'success'
  if (n <= 100) return 'info'
  if (n <= 150) return 'warning'
  return 'error'
})
const popLegend = computed(() => weather.value?.hourly.slice(0, 3).map((h) => h.pop) ?? [])

/**
 * 英雄卡渐变按天气现象取色：晴偏蓝、多云蓝灰、阴/雨偏灰、雷石板紫、雪冷灰蓝、雾霾暖灰。
 * 具体色值在 src/theme/sky.ts 统一维护（对白字对比度均 ≥ 4.5:1）。
 */
const heroGradient = computed(() => heroGradientOf(String(weather.value?.now?.cond || '')))

/**
 * Hero 骨架的占位色：Hero 底色是随天气变化的深蓝渐变，主题里 Skeleton 的浅灰（#f0f0f0 / #ddd）
 * 压在上面会像一块贴纸。这里用局部 n-config-provider 覆盖 Naive UI 的 Skeleton 主题变量
 * （color / colorEnd 两个官方主题键），改成半透明白，随渐变自然融合；不影响其它页面的骨架色。
 */
const heroSkeletonTheme = {
  Skeleton: {
    color: 'rgba(255, 255, 255, 0.26)',
    colorEnd: 'rgba(255, 255, 255, 0.10)'
  }
}

/** 每 refreshMin 分钟静默刷新一次；页面关闭或频率变化时重建定时器 */
function scheduleRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  const ms = Math.max(1, Number(refreshMin.value) || 5) * 60000
  refreshTimer = setInterval(() => { void loadWeather(true) }, ms)
}

/** 预警只来自和风天气的 /weatheralert 接口，不做本地规则推导 */
const alerts = computed<Array<{ id: string; level: string; title: string; body: string }>>(() => {
  const list = weather.value?.alerts ?? []
  return list.map((a) => ({
    id: a.id,
    level: a.level || '',
    title: a.title,
    body: (a.text || '') + (a.time ? '（发布于 ' + a.time + '）' : '')
  }))
})
const primaryAlert = computed(() => alerts.value[0] ?? null)

/* ---------- 工具 ---------- */
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e) }
function showTemp(c: number | undefined): string {
  if (c == null || !Number.isFinite(c)) return '—'
  return String(unit.value === 'F' ? Math.round((c * 9) / 5 + 32) : Math.round(c))
}
function showVisibility(v: number | string): string {
  return typeof v === 'number' ? v + 'km' : String(v ?? '')
}
function iconHref(icon: string): string {
  const map: Record<string, string> = {
    晴: '#i-sun', sunny: '#i-sun', sun: '#i-sun',
    多云: '#i-partly', partly: '#i-partly',
    阴: '#i-cloud', cloudy: '#i-cloud', overcast: '#i-cloud', cloud: '#i-cloud',
    雨: '#i-rain', rain: '#i-rain', 雷: '#i-thunder', thunder: '#i-thunder',
    night: '#i-moon', shirt: '#i-shirt', clothes: '#i-shirt',
    car: '#i-car', run: '#i-run', sport: '#i-run', drop: '#i-drop', uv: '#i-sun'
  }
  return map[icon] ?? '#i-partly'
}
/* ---------- 数据加载 ---------- */
async function loadSettings() {
  if (!hasBridge()) return
  try {
    const s = await call(() => bridge().settings.get('weather'), null)
    const cfg = s as WeatherSetting | null
    const u = cfg?.unit
    if (u === 'C' || u === 'F') unit.value = u
    refreshMin.value = Math.max(1, Number(cfg?.refreshMin || 5))
    scheduleRefresh()
  } catch (e) {
    log.exception('weather.settings', e)
  }
}

async function loadCities() {
  if (!hasBridge()) { cities.value = []; return }
  try {
    const rows = await call(() => bridge().weather.cities(), [] as WeatherCity[])
    cities.value = rows
    if (!cities.value.some((c) => c.id === currentId.value)) {
      const home = cities.value.find((c) => c.home) ?? cities.value[0]
      if (home) currentId.value = home.id
    }
  } catch (e) {
    log.exception('weather.cities', e)
    offline.value = true
  }
}

async function loadWeather(force = false) {
  const id = currentId.value
  if (!id) {
    weather.value = null
    lastError.value = '还没有城市：先在「多城市管理」里添加城市并完成定位'
    return
  }
  loading.value = true
  try {
    if (!hasBridge()) {
      weather.value = null
      lastError.value = '天气需要在桌面端运行（Electron）'
      return
    }
    const data = await call<WeatherData>(() => bridge().weather.fetch({ cityId: id, force }))
    weather.value = data
    offline.value = false
    lastError.value = data?.error || ''
    if (data?.now) cityTemps.value = { ...cityTemps.value, [id]: data.now.temp }
  } catch (e) {
    log.exception('weather.fetch', e)
    weather.value = null
    offline.value = false
    lastError.value = '天气取数失败：' + errMsg(e)
  } finally {
    loading.value = false
  }
}

/** 抽屉里每个城市显示当前温度：逐个读缓存/生成并记录 */
async function loadCityTemps() {
  if (!hasBridge()) { cityTemps.value = {}; return }
  const entries = await Promise.all(cities.value.map(async (c) => {
    try {
      const d = await call(() => bridge().weather.fetch({ cityId: c.id }), null as unknown as WeatherData)
      return [c.id, d ? d.now.temp : null] as [string, number | null]
    } catch (e) {
      log.exception('weather.cityTemp', e)
      return [c.id, null] as [string, number | null]
    }
  }))
  const map: Record<string, number> = {}
  entries.forEach(([id, t]) => { if (t != null) map[id] = t })
  cityTemps.value = { ...cityTemps.value, ...map }
}

async function loadNotices() {
  if (!hasBridge()) return
  try {
    notices.value = await call(() => bridge().notification.today(), [] as NotificationItem[])
  } catch (e) {
    log.exception('weather.notices', e)
  }
}

async function openAlertDetail() {
  showAlerts.value = true
  await loadNotices()
}

/* ---------- 城市管理：搜索候选 → 用户选择 ---------- */
async function doSearch() {
  const q = keyword.value.trim()
  if (!q) { message.warning('请输入城市名称'); return }
  if (!hasBridge()) { message.warning('城市搜索需要在桌面端运行'); return }
  searching.value = true
  searched.value = false
  try {
    results.value = await call(() => bridge().weather.searchCities({ keyword: q }), [] as WeatherCitySearchResult[])
    searched.value = true
    if (!results.value.length) message.info('没有匹配的城市，换个写法试试')
  } catch (err) {
    log.exception('weather.searchCities', err)
    results.value = []
    searched.value = true
    message.error('搜索失败：' + errMsg(err))
  } finally {
    searching.value = false
  }
}

/** 添加用户选中的候选：直接用它的 LocationID 与经纬度，不再按名字二次猜 */
async function addFromSearch(item: WeatherCitySearchResult) {
  addingId.value = item.qweatherId
  try {
    await call(() => bridge().weather.addCity(plain({
      name: item.name,
      qweatherId: item.qweatherId,
      lat: item.lat,
      lon: item.lon,
      adm1: item.adm1,
      adm2: item.adm2
    })))
    results.value = results.value.filter((x) => x.qweatherId !== item.qweatherId)
    keyword.value = ''
    searched.value = false
    await loadCities()
    await loadCityTemps()
    await loadWeather(true)
    message.success('已添加 ' + item.name + (item.adm2 ? '（' + item.adm2 + '）' : ''))
  } catch (err) {
    log.exception('weather.addCity', err)
    message.error('添加失败：' + errMsg(err))
  } finally {
    addingId.value = ''
  }
}

async function removeCity(c: WeatherCity) {
  if (c.home) { message.warning('定位城市不可删除'); return }
  try {
    if (!hasBridge()) {
      cities.value = cities.value.filter((x) => x.id !== c.id)
    } else {
      await call(() => bridge().weather.removeCity(c.id))
      await loadCities()
    }
    if (currentId.value === c.id) {
      const home = cities.value.find((x) => x.home) ?? cities.value[0]
      if (home) { currentId.value = home.id; await loadWeather() }
    }
    message.success('已删除')
  } catch (e) {
    log.exception('weather.removeCity', e)
    message.error(errMsg(e))
  }
}

async function setHome(c: WeatherCity) {
  if (c.home) return
  try {
    if (!hasBridge()) {
      cities.value = cities.value.map((x) => ({ ...x, home: x.id === c.id }))
    } else {
      await call(() => bridge().weather.setHome(c.id))
      await loadCities()
    }
    message.success('已设为定位城市')
  } catch (e) {
    log.exception('weather.setHome', e)
    message.error(errMsg(e))
  }
}

/** 重新经 GeoAPI 定位所有城市，补齐 LocationID 与经纬度后刷新当前城市 */
async function relocateAll() {
  if (!hasBridge()) return
  loading.value = true
  try {
    const r = await call(() => bridge().weather.relocate({}), null as unknown as { cities: WeatherCity[]; failed: string[] } | null)
    await loadCities()
    await loadWeather(true)
    await loadCityTemps()
    const failed = r?.failed ?? []
    if (failed.length) message.warning('部分城市定位失败：' + failed[0])
    else message.success('已完成重新定位')
  } catch (e) {
    log.exception('weather.relocate', e)
    message.error('定位失败：' + errMsg(e))
  } finally {
    loading.value = false
  }
}

async function switchCity(id: string) {
  if (id === currentId.value) return
  currentId.value = id
  showDrawer.value = false
  await loadWeather()
}

async function setUnit(u: 'C' | 'F') {
  unit.value = u
  if (!hasBridge()) return
  try {
    const cur = (await call(() => bridge().settings.get('weather'), null)) as WeatherSetting | null
    const base: WeatherSetting = cur ?? { source: 'qweather', host: '', geoHost: '', cacheMin: 30, offlineCache: true, alertPush: true, unit: 'C', apiKeySet: false }
    const patch = plain({ weather: { ...base, unit: u } }) as unknown as Partial<AllSettings>
    await call(() => bridge().settings.set(patch))
  } catch (e) {
    log.exception('weather.unit', e)
  }
}

/** 数据源配置留在天气页：与邮件/信息流一致，用侧边抽屉，不再跳设置 */
function openSourceSettings() { showSource.value = true }
function openDrawer() { showDrawer.value = true; void loadCityTemps() }

onMounted(async () => {
  await loadSettings()
  await loadCities()
  await loadWeather()
  scheduleRefresh()
})

watch(refreshMin, scheduleRefresh)
onBeforeUnmount(() => { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null } })
</script>

<template>
  <Shell>
    <template #subtitle>
      {{ currentCity?.name ?? '—' }} · 数据更新于 {{ fetchedAgo }} · 每 {{ refreshMin }} 分钟自动刷新
    </template>
    <template #actions>
      <div class="wx-head-actions">
        <span class="hc-status"><i class="hc-dot" :class="sourceTagType === 'warning' ? 'is-warn' : sourceTagType === 'success' ? 'is-ok' : 'is-info'" />{{ sourceLabel }}</span>
        <n-select
          class="wx-city-select"
          size="medium"
          :value="currentId"
          :options="cityOptions"
          @update:value="(v: string) => switchCity(v)"
        />
        <n-button size="medium" @click="openDrawer">多城市管理</n-button>
        <n-button size="medium" :loading="loading" @click="loadWeather(true)">刷新</n-button>
        <n-button size="medium" quaternary @click="openSourceSettings">数据源设置</n-button>
        <n-button-group class="wx-unit-group">
          <n-button size="medium" :type="unit === 'C' ? 'primary' : 'default'" @click="setUnit('C')">°C</n-button>
          <n-button size="medium" :type="unit === 'F' ? 'primary' : 'default'" @click="setUnit('F')">°F</n-button>
        </n-button-group>
      </div>
    </template>

    <div class="wx-body">
      <!-- 数据来源提示条：取数失败会带上具体原因，有缓存时仍展示缓存内容 -->
      <n-alert
        v-if="fetchError"
        class="wx-offline"
        :type="weather?.source === 'qweather' ? 'info' : 'warning'"
        :title="weather?.now ? '当前为' + sourceLabel + '数据，最后更新于 ' + fetchedAgo : '暂时没有可展示的天气数据'"
      >
        {{ fetchError }}
      </n-alert>

      <!-- Hero：外壳用 n-card，与其余卡片同一边框/圆角/阴影；内部渐变随天气现象变化 -->
      <n-card class="wx-hero-card" size="small" :content-style="'padding:0'">
        <div class="wx-hero" aria-label="当前天气" :style="{ background: heroGradient, color: 'var(--on-hero)' }">
        <!-- 骨架按真实 Hero 的版式排（图标 62px + 温度/现象/体感 + 4 项指标 + footer），
             加载完成时高度与元素位置不跳动 -->
        <n-config-provider v-if="loading && !weather" :theme-overrides="heroSkeletonTheme">
          <div class="wx-hero-skeleton" role="status" aria-label="加载中">
            <div class="wx-hero-top">
              <div class="wx-hero-left">
                <n-skeleton circle :width="62" :height="62" />
                <div class="wx-skel-main">
                  <n-skeleton text :width="120" :height="46" />
                  <n-skeleton text :width="88" :height="16" />
                  <n-skeleton text :width="76" :height="14" />
                </div>
              </div>
              <div class="wx-hero-metrics">
                <div v-for="n in 4" :key="n" class="wx-hero-metric wx-skel-metric">
                  <n-skeleton text :width="28" :height="12" />
                  <n-skeleton text :width="56" :height="18" />
                </div>
              </div>
            </div>
            <div class="wx-hero-foot">
              <n-skeleton v-for="n in 4" :key="n" text :width="88" :height="14" />
            </div>
          </div>
        </n-config-provider>
        <template v-else-if="wxNow">
          <div class="wx-hero-top">
            <div class="wx-hero-left">
              <svg class="wx-hero-icon" viewBox="0 0 24 24"><use :href="iconHref(wxNow.cond)" /></svg>
              <div class="wx-hero-main">
                <div class="wx-hero-temp">{{ showTemp(wxNow.temp) }}<sub class="wx-hero-deg">°</sub></div>
                <div class="wx-hero-cond">{{ wxNow.cond }}</div>
                <div class="wx-hero-feel">体感 {{ showTemp(wxNow.feel) }}°</div>
              </div>
            </div>
            <div class="wx-hero-metrics">
              <div class="wx-hero-metric"><span>湿度</span><strong>{{ wxNow.humidity }}%</strong></div>
              <div class="wx-hero-metric"><span>风速</span><strong>{{ wxNow.wind }}</strong></div>
              <div class="wx-hero-metric"><span>气压</span><strong>{{ wxNow.pressure }}hPa</strong></div>
              <div class="wx-hero-metric"><span>能见度</span><strong>{{ showVisibility(wxNow.visibility) }}</strong></div>
            </div>
          </div>
          <div class="wx-hero-foot">
            <span>紫外线 {{ uvText }}</span>
            <span>日出 {{ wxNow.sunrise }}</span>
            <span>日落 {{ wxNow.sunset }}</span>
            <span>未来 3 小时降水 {{ popLegend.join(' / ') }}%</span>
          </div>
        </template>
        </div>
      </n-card>

      <!-- 天气预警：只有和风返回预警时才出现，没有预警就不占版面 -->
      <n-alert
        v-if="primaryAlert"
        class="wx-alert"
        type="warning"
        :title="primaryAlert.title"
      >
        <div class="wx-alert-body">
          <span>{{ primaryAlert.body }}</span>
          <n-button size="tiny" quaternary @click="openAlertDetail">查看详情</n-button>
        </div>
      </n-alert>

      <n-card v-if="!wxNow && !loading" size="small" class="wx-full">
        <n-empty description="还没有天气数据：先在设置里填写和风天气的 API Host 与 Key，再添加城市">
          <div class="wx-head-actions">
            <n-button size="small" type="primary" @click="openSourceSettings">配置数据源</n-button>
            <n-button size="small" @click="openDrawer">添加城市</n-button>
          </div>
        </n-empty>
      </n-card>

      <div class="wx-grid">
        <!-- 未来 24 小时 -->
        <n-card class="wx-full" size="small">
          <template #header>
            <div class="wx-card-head">
              <span>未来 24 小时</span>
              <n-tag size="tiny" type="info">降水概率</n-tag>
            </div>
          </template>
          <n-scrollbar x-scrollable class="wx-hourly">
            <div class="wx-hourly-row">
              <div
                v-for="(h, i) in weather?.hourly ?? []"
                :key="h.time + '-' + i"
                class="wx-hour"
              >
                <span>{{ h.time }}</span>
                <svg class="wx-hour-icon" viewBox="0 0 24 24" :title="h.text || ''"><use :href="iconHref(h.icon)" /></svg>
                <strong>{{ showTemp(h.temp) }}°</strong>
                <n-tag size="tiny" :type="Number(h.pop) >= 60 ? 'warning' : 'default'">{{ h.pop }}%</n-tag>
              </div>
              <n-empty v-if="!weather?.hourly?.length" size="small" description="暂无逐小时数据" />
            </div>
          </n-scrollbar>
          <template #footer><span class="wx-card-foot">横向滚动查看全部 24 小时 · 数据缓存至本机</span></template>
        </n-card>

        <!-- 未来 7 天 -->
        <n-card class="wx-full" size="small">
          <template #header>
            <div class="wx-card-head">
              <span>未来 7 天</span>
              <n-button size="tiny" quaternary @click="message.info('当前数据源提供 7 天预报')">15 天预报</n-button>
            </div>
          </template>
          <div class="wx-days">
            <div
              v-for="(d, i) in weather?.daily ?? []"
              :key="d.dow + '-' + i"
              class="wx-day"
            >
              <span class="wx-dow">{{ i === 0 ? '今天' : d.dow }}</span>
              <svg class="wx-day-icon" viewBox="0 0 24 24"><use :href="iconHref(d.icon)" /></svg>
              <span class="wx-temps">{{ showTemp(d.hi) }}° <span class="wx-lo">{{ showTemp(d.lo) }}°</span></span>
              <span class="wx-pop">{{ d.pop }}%</span>
            </div>
          </div>
        </n-card>

        <!-- 空气质量 -->
        <n-card size="small" title="空气质量">
          <template #header-extra><n-tag size="tiny" :type="aqiType">实测</n-tag></template>
          <div class="wx-aqi-top">
            <span class="wx-aqi-num">{{ weather?.aqi.num ?? '—' }}</span>
            <n-tag size="small" :type="aqiType">{{ weather?.aqi.level ?? '—' }}</n-tag>
          </div>
          <div class="wx-aqi-metrics">
            <div><span>PM2.5</span><strong>{{ weather?.aqi.pm25 ?? '—' }}</strong></div>
            <div><span>PM10</span><strong>{{ weather?.aqi.pm10 ?? '—' }}</strong></div>
            <div><span>O₃</span><strong>{{ weather?.aqi.o3 ?? '—' }}</strong></div>
          </div>
          <p class="wx-card-foot">
            <template v-if="weather?.aqi.primary">首要污染物 {{ weather.aqi.primary }}<template v-if="weather?.aqi.no2 != null"> · NO₂ {{ weather.aqi.no2 }}</template><template v-if="weather?.aqi.so2 != null"> · SO₂ {{ weather.aqi.so2 }}</template></template>
            <template v-else>暂无首要污染物数据</template>
          </p>
        </n-card>

        <!-- 生活指数 -->
        <n-card size="small" title="生活指数">
          <template #header-extra><n-tag size="tiny">依据当前天气生成</n-tag></template>
          <div class="wx-life">
            <div v-for="(it, i) in weather?.indices ?? []" :key="it.name + '-' + i" class="wx-life-item">
              <svg class="wx-life-icon" viewBox="0 0 24 24"><use :href="iconHref(it.icon)" /></svg>
              <div><strong>{{ it.name }}</strong><p>{{ it.text }}</p></div>
            </div>
          </div>
        </n-card>
      </div>
    </div>

    <!-- 多城市管理抽屉：GeoAPI 搜索 → 选择候选 → 加入列表 -->
    <n-drawer v-model:show="showDrawer" :width="380" placement="right">
      <n-drawer-content title="多城市管理" closable :native-scrollbar="false">
        <div class="wx-city-search">
          <n-input
            v-model:value="keyword"
            size="small"
            clearable
            placeholder="搜索城市：输入名称后回车"
            @keyup.enter="doSearch"
            @clear="results = []; searched = false"
          />
          <n-button size="small" type="primary" :loading="searching" @click="doSearch">搜索</n-button>
        </div>

        <div v-if="results.length" class="wx-city-results">
          <button
            v-for="r in results"
            :key="r.qweatherId"
            type="button"
            class="wx-city-result"
            :disabled="addingId === r.qweatherId"
            @click="addFromSearch(r)"
          >
            <span class="wx-city-result-main">
              <strong>{{ r.name }}</strong>
              <small>{{ [r.adm1, r.adm2, r.country].filter(Boolean).join(' · ') }}</small>
            </span>
            <n-tag size="tiny" :type="addingId === r.qweatherId ? 'default' : 'success'">
              {{ addingId === r.qweatherId ? '添加中' : '添加' }}
            </n-tag>
          </button>
        </div>
        <n-empty v-else-if="searched && !searching" size="small" description="没有匹配的城市" />

        <div class="wx-city-search-title">已添加城市（{{ cities.length }}）</div>
        <div class="wx-city-list">
          <div v-for="c in cities" :key="c.id" class="wx-city-row">
            <span class="wx-city-name">
              <svg v-if="c.home" class="wx-city-pin" viewBox="0 0 24 24"><use href="#i-pin" /></svg>
              {{ c.name }}
              <small v-if="c.adm2" class="wx-city-adm">{{ c.adm2 }}</small>
            </span>
            <n-tag size="tiny" :type="c.home ? 'success' : 'default'">{{ c.home ? '定位' : '常驻' }}</n-tag>
            <n-button size="tiny" quaternary @click="switchCity(c.id)">{{ showTemp(cityTemps[c.id]) }}°</n-button>
            <n-button size="tiny" quaternary :disabled="c.home" @click="setHome(c)">设为定位</n-button>
            <n-button size="tiny" quaternary :disabled="c.home" @click="removeCity(c)">删除</n-button>
          </div>
          <n-empty v-if="!cities.length" size="small" description="还没有城市，搜索后添加" />
        </div>

        <template #footer>
          <div class="wx-city-add">
            <n-button size="small" :loading="loading" @click="relocateAll">重新定位全部城市</n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 数据源抽屉：API Host / Key / 缓存策略 / 自检 -->
    <n-drawer v-model:show="showSource" :width="620" placement="right">
      <n-drawer-content title="天气数据源" closable :native-scrollbar="false">
        <WeatherSourcePanel embedded />
      </n-drawer-content>
    </n-drawer>

    <!-- 预警详情：和风天气返回的预警 + 今日通知流 -->
    <n-modal v-model:show="showAlerts" preset="card" class="wx-modal" title="天气预警与提醒" :bordered="false">
      <n-empty v-if="!alerts.length" size="small" description="当前无生效预警" />
      <div v-else class="wx-alert-list">
        <n-alert v-for="a in alerts" :key="a.id" type="warning" :title="a.title" class="wx-alert-item">
          {{ a.body }}
        </n-alert>
      </div>

      <div class="wx-alert-sub">今日本地通知流</div>
      <n-empty v-if="!notices.length" size="small" description="暂无提醒" />
      <div v-for="n in notices.slice(0, 6)" :key="n.id" class="wx-notice-row">
        <n-tag size="tiny" :type="n.level === 'strong' ? 'warning' : 'default'">{{ n.module }}</n-tag>
        <span class="wx-notice-title">{{ n.title }}</span>
        <span class="wx-notice-time">{{ new Date(n.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</span>
      </div>

      <n-descriptions :column="2" label-placement="left" size="small" class="wx-alert-meta">
        <n-descriptions-item label="城市">{{ currentCity?.name ?? '—' }}</n-descriptions-item>
        <n-descriptions-item label="数据时间">{{ fetchedAgo }}</n-descriptions-item>
        <n-descriptions-item label="预警规则">降水 / 高温 / 寒潮 / 风力</n-descriptions-item>
        <n-descriptions-item label="推送开关">在设置 › 天气数据源中控制</n-descriptions-item>
      </n-descriptions>
    </n-modal>
  </Shell>
</template>