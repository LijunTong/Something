<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NModal, NInput, NEmpty, NSpin, NTag } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { PARCEL_ENABLED } from '@/lib/features'
import type { SearchGroup, SearchItem } from '@/types/api'
import '@/styles/search.css'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [boolean] }>()
const router = useRouter()

const keyword = ref('')
const loading = ref(false)
const groups = ref<SearchGroup[]>([])
const total = ref(0)
const activeIndex = ref(0)
const inputRef = ref<{ focus?: () => void } | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let lastQuery = ''

/** 展平后的键盘导航列表，保持与分组渲染顺序一致 */
const flat = computed(() => groups.value.flatMap((g) => g.items.map((it) => ({ ...it, module: g.module, label: g.label }))))

function activeOf(moduleName: string, id: string): boolean {
  const item = flat.value[activeIndex.value]
  return !!item && item.module === moduleName && item.id === id
}

watch(() => props.show, (v) => {
  if (!v) {
    if (timer) { clearTimeout(timer); timer = null }
    return
  }
  keyword.value = ''
  groups.value = []
  total.value = 0
  activeIndex.value = 0
  lastQuery = ''
  void nextTick(() => inputRef.value?.focus?.())
})

watch(keyword, () => {
  if (timer) clearTimeout(timer)
  const q = keyword.value.trim()
  if (!q) { groups.value = []; total.value = 0; return }
  // 250ms 防抖：连续输入只在停顿后发起一次 IPC
  timer = setTimeout(() => { void run(q) }, 250)
})

async function run(q: string) {
  if (!hasBridge()) return
  if (q === lastQuery) return
  lastQuery = q
  loading.value = true
  try {
    const r = await call(() => bridge().search.query({ keyword: q }), { keyword: q, total: 0, groups: [] as SearchGroup[] })
    // 输入已变化时丢弃旧结果，避免竞态导致列表跳动
    if (q !== keyword.value.trim()) return
    groups.value = r.groups
    total.value = r.total
    activeIndex.value = 0
  } catch (e) {
    log.exception('search.query', e)
    groups.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function move(step: number) {
  if (!flat.value.length) return
  activeIndex.value = (activeIndex.value + step + flat.value.length) % flat.value.length
  void nextTick(() => {
    const el = document.querySelector('.search-modal .sr-item-active')
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      ;(el as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
  })
}

function open(item?: { target: string }) {
  const hit = item || flat.value[activeIndex.value]
  if (!hit) return
  emit('update:show', false)
  void router.push(hit.target)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); open() }
  else if (e.key === 'Escape') { e.preventDefault(); emit('update:show', false) }
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    class="search-modal"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="sr-head">
      <n-input
        ref="inputRef"
        v-model:value="keyword"
        size="large"
        clearable
        :placeholder="'搜索任务、日程、邮件、文章、' + (PARCEL_ENABLED ? '包裹、' : '') + '城市…'"
        @keydown="onKeydown"
      />
      <n-tag v-if="total" size="small">{{ total }} 条结果</n-tag>
    </div>

    <n-spin :show="loading">
      <div v-if="!keyword.trim()" class="sr-hint">
        输入关键词开始搜索：标题、地点、发件人{{ PARCEL_ENABLED ? '、单号' : '' }}、城市名都可以。<br />
        用 ↑ ↓ 选择结果，Enter 打开，Esc 关闭。
      </div>
      <n-empty v-else-if="!loading && !flat.length" description="没有匹配结果" />
      <div v-else class="sr-groups">
        <div v-for="g in groups" :key="g.module" class="sr-group">
          <div class="sr-group-label">
            {{ g.label }}
            <span class="sr-group-count">{{ g.items.length }}</span>
          </div>
          <div
            v-for="it in g.items"
            :key="g.module + it.id"
            role="button"
            tabindex="0"
            class="sr-item"
            :class="{ 'sr-item-active': activeOf(g.module, it.id) }"
            :style="activeOf(g.module, it.id) ? { background: 'var(--primary-softer)' } : undefined"
            @click="open(it)"
            @keydown.enter.prevent="open(it)"
          >
            <span class="sr-item-main">
              <strong>{{ it.title }}</strong>
              <small>{{ it.meta }}</small>
            </span>
            <span class="sr-item-open">打开</span>
          </div>
        </div>
      </div>
    </n-spin>

    <template #footer>
      <div class="sr-foot">↑↓ 选择 · Enter 打开 · Esc 关闭 · Ctrl K 随时唤起</div>
    </template>
  </n-modal>
</template>
