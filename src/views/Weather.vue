<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton, NButtonGroup, NInput, NTag, NSpin, NSkeleton, NAlert, NCard,
  NDrawer, NDrawerContent, NEmpty, NScrollbar, NSelect, NModal,
  NDescriptions, NDescriptionsItem, useMessage
} from 'naive-ui'
import Shell from '@/components/Shell.vue'
import { call, bridge, plain, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { AllSettings, NotificationItem, WeatherCity, WeatherData, WeatherSetting } from '@/types/api'
import '@/styles/weather.css'

const message = useMessage()
const router = useRouter()

/* ---------- 离线 fixture：无 IPC 时保证页面可渲染（结构对齐 WeatherData） ---------- */
const FALLBACK_CITIES: WeatherCity[] = [
  { id: 'city-foshan', name: '佛山', home: true, sort: 0 },
  { id: 'city-guangzhou', name: '广州', home: false, sort: 1 },
  { id: 'city-shenzhen', name: '深圳', home: false, sort: 2 }
]
const CITY_BASE: Record<string, number> = { 佛山: 24, 广州: 25, 深圳: 26, 北京: 21 }

function makeFixture(city: WeatherCity): WeatherData {
  const base = CITY_BASE[city.name] ?? 24
  const icons = ['partly', 'cloud', 'rain', 'sun']
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    time: i === 0 ? '现在' : String(i).padStart(2, '0') + ':00',
    icon: icons[i % icons.length] ?? 'partly',
    temp: base + Math.round(2 * Math.sin((i / 24) * Math.PI * 2)),
    pop: (i * 9) % 70
  }))
  const dows = ['今天', '明天', '周日', '周一', '周二', '周三', '周四']
  const daily = dows.map((dow, i) => ({
    dow, icon: icons[i % icons.length] ?? 'partly',
    hi: base + 3 - (i % 2), lo: base - 5 + (i % 2), pop: (i * 13) % 60
  }))
  return {
    cityId: city.id, name: city.name, fromCache: true, fetchedAt: Date.now(),
    now: { temp: base, cond: '多云', feel: base + 2, humidity: 68, wind: '东南风 3 级', pressure: 1012, visibility: 10, uv: 3, sunrise: '06:32', sunset: '17:48' },
    hourly, daily,
    aqi: { num: 68, level: '良', pm25: 35, pm10: 58, o3: 92 },
    indices: [
      { name: '穿衣', icon: 'clothes', text: '薄外套或长袖，早晚偏凉' },
      { name: '洗车', icon: 'car', text: '未来 24 小时有雨，暂不宜' },
      { name: '运动', icon: 'sport', text: '户外有降雨，建议室内' },
      { name: '晾晒', icon: 'drop', text: '湿度较高，不易晾干' }
    ]
  }
}

/* ---------- 状态 ---------- */
const cities = ref<WeatherCity[]>(FALLBACK_CITIES.slice())
const currentId = ref('city-foshan')
const weather = ref<WeatherData | null>(null)
const loading = ref(false)
const offline = ref(!hasBridge())
const showDrawer = ref(false)
const showAlerts = ref(false)
const search = ref('')
const newCityName = ref('')
const unit = ref<'C' | 'F'>('C')
const cityTemps = ref<Record<string, number>>({})
const notices = ref<NotificationItem[]>([])

/* ---------- 计算 ---------- */
const currentCity = computed(() => cities.value.find((c) => c.id === currentId.value) ?? cities.value[0] ?? null)
const cityOptions = computed(() => cities.value.map((c) => ({ label: c.name + (c.home ? '（定位）' : ''), value: c.id })))
const wxNow = computed(() => weather.value?.now ?? null)
const filteredCities = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q ? cities.value.filter((c) => c.name.toLowerCase().includes(q)) : cities.value
})
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
const aqiType = computed(() => {
  const n = weather.value?.aqi.num ?? 0
  if (n <= 50) return 'success'
  if (n <= 100) return 'info'
  if (n <= 150) return 'warning'
  return 'error'
})
const popLegend = computed(() => weather.value?.hourly.slice(0, 3).map((h) => h.pop) ?? [])

/** 预警：由逐小时降水、日最高/最低温与风力规则生成（本地规则，不做智能推断） */
const alerts = computed(() => {
  const w = weather.value
  if (!w) return [] as Array<{ id: string; level: string; title: string; body: string }>
  const out: Array<{ id: string; level: string; title: string; body: string }> = []
  const rainy = w.hourly.slice(0, 6).filter((h) => Number(h.pop) >= 70)
  if (rainy.length >= 2) {
    const max = Math.max(...rainy.map((h) => Number(h.pop) || 0))
    out.push({ id: 'rain', level: '黄色', title: '暴雨黄色预警：预计未来 6 小时有强降雨', body: '最高降水概率 ' + max + '%，出门带伞并避开低洼路段。' })
  }
  const hi = w.daily.length ? Math.max(...w.daily.map((d) => d.hi)) : 0
  if (hi >= 35) out.push({ id: 'heat', level: '橙色', title: '高温橙色预警：最高气温 ' + hi + '°', body: '注意补水防晒，避免长时间户外活动。' })
  const lo = w.daily.length ? Math.min(...w.daily.map((d) => d.lo)) : 99
  if (lo <= 5) out.push({ id: 'cold', level: '蓝色', title: '寒潮蓝色预警：最低气温 ' + lo + '°', body: '早晚温差大，注意加衣。' })
  const lv = Number((String(w.now.wind).match(/(\d+)\s*级/) || [])[1] || 0)
  if (lv >= 6) out.push({ id: 'wind', level: '黄色', title: '大风黄色预警：当前 ' + w.now.wind, body: '注意高处坠物，骑行注意侧风。' })
  return out
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
function fixtureFor(id: string): WeatherData {
  const c = cities.value.find((x) => x.id === id) ?? currentCity.value ?? FALLBACK_CITIES[0]
  return makeFixture(c as WeatherCity)
}

/* ---------- 数据加载 ---------- */
async function loadSettings() {
  if (!hasBridge()) return
  try {
    const s = await call(() => bridge().settings.get('weather'), null)
    const u = (s as WeatherSetting | null)?.unit
    if (u === 'C' || u === 'F') unit.value = u
  } catch (e) {
    log.exception('weather.settings', e)
  }
}

async function loadCities() {
  if (!hasBridge()) { cities.value = FALLBACK_CITIES.slice(); return }
  try {
    const rows = await call(() => bridge().weather.cities(), FALLBACK_CITIES)
    cities.value = rows.length ? rows : FALLBACK_CITIES.slice()
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
  loading.value = true
  try {
    if (!hasBridge()) {
      weather.value = fixtureFor(id)
      offline.value = true
      return
    }
    const data = await call<WeatherData>(() => bridge().weather.fetch({ cityId: id, force }), fixtureFor(id))
    weather.value = data
    offline.value = false
    if (data) cityTemps.value = { ...cityTemps.value, [id]: data.now.temp }
  } catch (e) {
    log.exception('weather.fetch', e)
    weather.value = fixtureFor(id)
    offline.value = true
  } finally {
    loading.value = false
  }
}

/** 抽屉里每个城市显示当前温度：逐个读缓存/生成并记录 */
async function loadCityTemps() {
  if (!hasBridge()) {
    const map: Record<string, number> = {}
    cities.value.forEach((c) => { map[c.id] = CITY_BASE[c.name] ?? 24 })
    cityTemps.value = map
    return
  }
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

/* ---------- 城市管理 ---------- */
async function addCity() {
  const name = newCityName.value.trim()
  if (!name) { message.warning('请输入城市名'); return }
  try {
    if (!hasBridge()) {
      cities.value = [...cities.value, { id: 'city-local-' + Date.now(), name, home: false, sort: cities.value.length }]
    } else {
      await call(() => bridge().weather.addCity(plain({ name })))
      await loadCities()
    }
    newCityName.value = ''
    await loadCityTemps()
    message.success('城市已添加')
  } catch (e) {
    log.exception('weather.addCity', e)
    message.error(errMsg(e))
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
    const base: WeatherSetting = cur ?? { source: 'qweather', host: 'api.qweather.com', cacheMin: 30, offlineCache: true, alertPush: true, unit: 'C', apiKeySet: false }
    const patch = plain({ weather: { ...base, unit: u } }) as unknown as Partial<AllSettings>
    await call(() => bridge().settings.set(patch))
  } catch (e) {
    log.exception('weather.unit', e)
  }
}

function openSourceSettings() { void router.push({ path: '/settings', query: { panel: 'weather' } }) }
function openDrawer() { showDrawer.value = true; void loadCityTemps() }

onMounted(async () => {
  await loadSettings()
  await loadCities()
  await loadWeather()
})
</script>

<template>
  <Shell>
    <template #subtitle>
      {{ currentCity?.name ?? '—' }} · 数据更新于 {{ fetchedAgo }}（本地缓存）
    </template>
    <template #actions>
      <div class="wx-head-actions">
        <n-select
          class="wx-city-select"
          size="small"
          :value="currentId"
          :options="cityOptions"
          @update:value="(v: string) => switchCity(v)"
        />
        <n-button size="small" @click="openDrawer">多城市管理</n-button>
        <n-button size="small" :loading="loading" @click="loadWeather(true)">刷新</n-button>
        <n-button size="small" quaternary @click="openSourceSettings">数据源设置</n-button>
        <n-button-group class="wx-unit-group">
          <n-button size="small" :type="unit === 'C' ? 'primary' : 'default'" @click="setUnit('C')">°C</n-button>
          <n-button size="small" :type="unit === 'F' ? 'primary' : 'default'" @click="setUnit('F')">°F</n-button>
        </n-button-group>
      </div>
    </template>

    <div class="wx-body">
      <!-- 离线提示条 -->
      <n-alert v-if="offline" class="wx-offline" type="warning" title="当前为离线数据，展示本地缓存内容">
        最后更新于 {{ fetchedAgo }}，联网后点击刷新即可重新拉取。
      </n-alert>

      <!-- Hero 当前天气：产品独占视觉（超大温度数字），布局自写，配色取令牌 -->
      <section
        class="wx-hero"
        aria-label="当前天气"
        :style="{
          background: 'linear-gradient(105deg, var(--hero-from) 0%, var(--hero-to) 58%, var(--hero-to) 100%)',
          color: 'var(--on-hero)'
        }"
      >
        <div v-if="loading && !weather" class="wx-hero-skeleton" aria-label="加载中">
          <n-skeleton text style="width: 120px; height: 48px" />
          <n-skeleton text style="width: 90px; height: 16px" />
          <div class="wx-hero-metrics">
            <n-skeleton v-for="n in 4" :key="n" text style="width: 78px; height: 34px" />
          </div>
        </div>
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
      </section>

      <!-- 天气预警条（无预警时降级为动态提示） -->
      <n-alert
        class="wx-alert"
        :type="primaryAlert ? 'warning' : 'success'"
        :title="primaryAlert ? primaryAlert.title : '天气动态已更新：当前无生效预警'"
      >
        <div class="wx-alert-body">
          <span>{{ primaryAlert ? primaryAlert.body : '按城市本地规则检查降水、高温、寒潮与风力，命中即为预警。' }}</span>
          <n-button size="tiny" quaternary @click="openAlertDetail">查看详情</n-button>
        </div>
      </n-alert>

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
                <svg class="wx-hour-icon" viewBox="0 0 24 24"><use :href="iconHref(h.icon)" /></svg>
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

    <!-- 多城市管理抽屉 -->
    <n-drawer v-model:show="showDrawer" :width="360" placement="right">
      <n-drawer-content title="多城市管理" closable :native-scrollbar="false">
        <n-input v-model:value="search" size="small" placeholder="搜索城市" clearable />
        <div class="wx-city-list">
          <div v-for="c in filteredCities" :key="c.id" class="wx-city-row">
            <span class="wx-city-name">
              <svg v-if="c.home" class="wx-city-pin" viewBox="0 0 24 24"><use href="#i-pin" /></svg>
              {{ c.name }}
            </span>
            <n-tag size="tiny" :type="c.home ? 'success' : 'default'">{{ c.home ? '定位' : '常驻' }}</n-tag>
            <n-button size="tiny" quaternary @click="switchCity(c.id)">{{ showTemp(cityTemps[c.id]) }}°</n-button>
            <n-button size="tiny" quaternary :disabled="c.home" @click="setHome(c)">设为定位</n-button>
            <n-button size="tiny" quaternary :disabled="c.home" @click="removeCity(c)">删除</n-button>
          </div>
          <n-empty v-if="!filteredCities.length" size="small" description="没有匹配的城市" />
        </div>
        <template #footer>
          <div class="wx-city-add">
            <n-input v-model:value="newCityName" size="small" placeholder="输入城市名" @keyup.enter="addCity" />
            <n-button size="small" type="primary" @click="addCity">添加城市</n-button>
          </div>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 预警详情：本地规则生成的预警 + 今日通知流 -->
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
