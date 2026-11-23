<script setup lang="ts">
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { computed, h, onMounted, ref } from 'vue'
import {
  NCard, NButton, NDataTable, NTag, NInput, NSelect, NSwitch, NUpload, NAvatar,
  NEmpty, NSpin, NPopconfirm, NAlert, NModal, NForm, NFormItem, useMessage
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { call, bridge, hasBridge, plain } from '@/lib/ipc'
import { siteIconUrl, siteInitial } from '@/lib/siteIcon'
import { log } from '@/lib/logger'
import { useSettings } from '@/composables/useSettings'
import type { FeedSetting, FeedGroupRow, FeedSource, ExportResult } from '@/types/api'

const props = defineProps<{ embedded?: boolean }>()
/** 嵌入到信息流页时通知父级重新加载订阅源与文章 */
const emit = defineEmits<{ changed: [] }>()
const { settings, save } = useSettings()
const message = useMessage()

const sources = ref<FeedSource[]>([])
const groups = ref<FeedGroupRow[]>([])
const loading = ref(false)
const busy = ref('')
const newTitle = ref('')
const newUrl = ref('')
const newGroup = ref<string | null>(null)
const newInterval = ref<number | null>(null)
/** 新增区域默认收起，点「添加订阅」再展开 */
const showAdd = ref(false)
const showEdit = ref(false)
const editId = ref('')
const editForm = ref({ title: '', url: '', groupId: '' as string | null, intervalMin: 60 })

const intervalOptions = [
  { label: '每 30 分钟', value: 30 },
  { label: '每小时', value: 60 },
  { label: '每 6 小时', value: 360 },
  { label: '每天', value: 1440 }
]

const groupOptions = computed(() => groups.value.map((g) => ({ label: g.name, value: g.id })))
/** 默认分类：新增订阅不选分组时落这里，服务端也会再兜一层 */
const defaultGroupId = computed(() => groups.value.find((g) => g.isDefault)?.id ?? groups.value[0]?.id ?? null)

/** 展开新增区时把分组预选成默认分类；收起不清空，避免误丢已输入内容 */
function toggleAdd(): void {
  showAdd.value = !showAdd.value
  if (showAdd.value) newGroup.value = defaultGroupId.value
}
const sourceIntervalOptions = [{ label: '跟随默认', value: 0 }, ...intervalOptions]

function groupName(id: string | null): string {
  if (!id) return '未分组'
  return groups.value.find((g) => g.id === id)?.name || '未分组'
}

function intervalLabel(min: number): string {
  if (min >= 1440) return '每天'
  if (min >= 360) return '每 6 小时'
  if (min >= 60) return Math.round(min / 60) + ' 小时'
  return min + ' 分钟'
}

const columns = computed<DataTableColumns<FeedSource>>(() => [
  {
    title: '图标',
    key: 'icon',
    width: 64,
    render: (row) => h(NAvatar, {
      size: 22,
      round: true,
      src: siteIconUrl(row.url)
    }, { fallback: () => siteInitial(row.title, row.url) })
  },
  {
    title: '名称 / URL',
    key: 'title',
    render: (row) => h('div', { class: 'set-cell' }, [
      h('strong', row.title || row.url),
      h('small', row.url)
    ])
  },
  { title: '分组', key: 'groupId', width: 110, render: (row) => groupName(row.groupId) },
  { title: '频率', key: 'intervalMin', width: 96, render: (row) => intervalLabel(row.intervalMin) },
  {
    title: '状态',
    key: 'enabled',
    width: 70,
    render: (row) => h(NSwitch, {
      size: 'small',
      value: row.enabled,
      'onUpdate:value': (v: boolean) => toggleSource(row, v)
    })
  },
  {
    title: '',
    key: 'actions',
    width: 132,
    render: (row) => h('div', { class: 'set-inline' }, [
      h(NButton, { size: 'tiny', quaternary: true, onClick: () => startEdit(row) }, { default: () => '修改' }),
      h(NPopconfirm, { onPositiveClick: () => removeSource(row) }, {
        trigger: () => h(NButton, { size: 'tiny', quaternary: true, type: 'error' }, { default: () => '删除' }),
        default: () => '删除订阅源会一并清理已抓取文章，确定继续？'
      })
    ])
  }
])

async function load() {
  if (!hasBridge()) { sources.value = []; groups.value = []; return }
  loading.value = true
  try {
    const [s, g] = await Promise.all([
      call(() => bridge().feed.sources(), [] as FeedSource[]),
      call(() => bridge().feed.groups(), [] as FeedGroupRow[])
    ])
    sources.value = s
    groups.value = g
    // 分组被删/改名后，新增区里残留的旧值重置回默认分类
    if (!newGroup.value || !groups.value.some((x) => x.id === newGroup.value)) newGroup.value = defaultGroupId.value
  } catch (e) {
    log.exception('settings.feed', e)
    message.error('读取订阅源失败：' + ((e as Error).message || '未知错误'))
  } finally {
    loading.value = false
  }
}

async function saveFeed(patch: Partial<FeedSetting>) {
  try {
    await save('feed', { ...settings.value.feed, ...patch })
  } catch (e) {
    message.error('保存失败：' + ((e as Error).message || '未知错误'))
  }
}

/**
 * 新增区的分组既可下拉选已有项，也可直接输入名字（n-select tag 模式）：
 * 命中的是分组 id 就直接用；命中的是名字就换成 id；都没命中就当场建一个分组。
 */
async function resolveGroupId(): Promise<string | null> {
  const raw = newGroup.value
  // 没选也没输入就落默认分类：与「新增时默认选中默认分组」一致
  if (!raw) return defaultGroupId.value
  const text = String(raw).trim()
  if (!text) return defaultGroupId.value
  const byId = groups.value.find((g) => g.id === text)
  if (byId) return byId.id
  const byName = groups.value.find((g) => g.name === text)
  if (byName) return byName.id
  const rows = await call(() => bridge().feed.addGroup(plain({ name: text })), [] as FeedGroupRow[])
  groups.value = rows
  const created = rows.find((g) => g.name === text)
  return created ? created.id : null
}

async function addSource() {
  const url = newUrl.value.trim()
  if (!url) { message.warning('请填写 RSS / Atom 地址'); return }
  busy.value = 'add'
  try {
    const groupId = await resolveGroupId()
    // 主进程契约返回「订阅源列表」，直接用返回值覆盖即可
    await call(
      () => bridge().feed.addSource(plain({ url, title: newTitle.value.trim() || undefined, groupId, intervalMin: newInterval.value || settings.value.feed.defaultInterval })),
      [] as FeedSource[]
    )
    newUrl.value = ''
    newTitle.value = ''
    // 连续添加时仍默认落默认分类
    newGroup.value = defaultGroupId.value
    await load()
    emit('changed')
    message.success('订阅源已添加')
  } catch (e) {
    log.exception('settings.feed.add', e)
    message.error('添加失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = ''
  }
}

/** 修改订阅源：sourceId 不变，已抓文章不会丢 */
function startEdit(row: FeedSource) {
  editId.value = row.id
  editForm.value = {
    title: row.title || '',
    url: row.url,
    groupId: row.groupId,
    intervalMin: row.intervalMin || settings.value.feed.defaultInterval
  }
  showEdit.value = true
}

async function saveEdit() {
  const f = editForm.value
  if (!/^https?:\/\//i.test(f.url.trim())) { message.warning('请输入有效的 RSS 链接'); return }
  busy.value = 'edit'
  try {
    await call(() => bridge().feed.updateSource(plain({
      id: editId.value,
      url: f.url.trim(),
      title: f.title.trim() || undefined,
      groupId: f.groupId || null,
      intervalMin: Number(f.intervalMin)
    })), null as unknown as FeedSource)
    showEdit.value = false
    await load()
    emit('changed')
    message.success('订阅源已更新')
  } catch (e) {
    log.exception('settings.feed.update', e)
    message.error('更新失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = ''
  }
}

async function toggleSource(row: FeedSource, enabled: boolean) {
  try {
    await call(() => bridge().feed.toggleSource({ id: row.id, enabled }))
    row.enabled = enabled
    emit('changed')
  } catch (e) {
    log.exception('settings.feed.toggle', e)
    message.error('更新失败：' + ((e as Error).message || '未知错误'))
  }
}

async function removeSource(row: FeedSource) {
  try {
    await call(() => bridge().feed.removeSource(row.id))
    sources.value = sources.value.filter((s) => s.id !== row.id)
    emit('changed')
    message.success('订阅源已删除')
  } catch (e) {
    log.exception('settings.feed.remove', e)
    message.error('删除失败：' + ((e as Error).message || '未知错误'))
  }
}

async function refreshAll() {
  busy.value = 'refresh'
  try {
    const r = await call(() => bridge().feed.refresh({}), null as unknown as { added: number; failed: number } | null)
    message.success('抓取完成：新增 ' + (r?.added ?? 0) + ' 篇，失败 ' + (r?.failed ?? 0) + ' 个源')
    await load()
  } catch (e) {
    log.exception('settings.feed.refresh', e)
    message.error('抓取失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = ''
  }
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('FILE_READ_FAILED'))
    reader.readAsText(file, 'utf-8')
  })
}

async function importOPML(payload: { file: { file: File | null } }) {
  const raw = payload?.file?.file
  if (!raw) return
  busy.value = 'opml'
  try {
    const text = await readFileText(raw)
    const r = await call(() => bridge().feed.importOPML({ text }), null as unknown as { imported: number } | null)
    message.success('已导入 ' + (r?.imported ?? 0) + ' 个订阅源')
    await load()
    emit('changed')
  } catch (e) {
    log.exception('settings.feed.opml', e)
    message.error('导入失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = ''
  }
}

async function exportOPML() {
  busy.value = 'export'
  try {
    const r = await call(() => bridge().settings.exportData({ kind: 'opml' }), null as unknown as ExportResult)
    message.success('已导出：' + (r?.name || 'feeds.opml'))
    if (r?.path) await call(() => bridge().system.openPath(r.path), false)
  } catch (e) {
    log.exception('settings.feed.export', e)
    message.error('导出失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<template>
  <n-card size="small" :title="props.embedded ? undefined : '订阅源'">
    <n-alert type="info" :bordered="false">
      通过 RSS / Atom 抓取，订阅与文章缓存保存在本机，联网仅用于拉取 feed。
    </n-alert>

    <div class="set-field">
      <span class="set-field-key">默认抓取频率</span>
      <n-select
        class="set-select"
        size="small"
        :value="settings.feed.defaultInterval"
        :options="intervalOptions"
        @update:value="(v: number) => saveFeed({ defaultInterval: v })"
      />
    </div>
    <div class="set-field">
      <span class="set-field-key">离线保留文章正文</span>
      <n-switch :value="settings.feed.keepContent" @update:value="(v: boolean) => saveFeed({ keepContent: v })" />
    </div>

    <!-- 订阅源数量与「添加订阅」入口：NCard 在无标题时不渲染 header-extra，所以放进内容区 -->
    <div class="set-actions">
      <n-tag size="small">{{ sources.length }} 个来源</n-tag>
      <n-button size="small" type="primary" @click="toggleAdd">{{ showAdd ? '收起' : '+ 添加订阅' }}</n-button>
    </div>

    <SectionTitle title="已订阅" />
    <n-spin :show="loading">
      <n-empty v-if="!sources.length" size="small" description="还没有订阅源" />
      <n-data-table
        v-else
        size="small"
        :columns="columns"
        :data="sources"
        :bordered="false"
        :single-line="false"
        :row-key="(row: FeedSource) => row.id"
      />
    </n-spin>

    <div class="set-actions">
      <n-upload :show-file-list="false" :default-upload="false" accept=".opml,.xml" @change="importOPML">
        <n-button size="small" :loading="busy === 'opml'">OPML 导入</n-button>
      </n-upload>
      <n-button size="small" :loading="busy === 'export'" @click="exportOPML">OPML 导出</n-button>
      <n-button size="small" :loading="busy === 'refresh'" @click="refreshAll">立即抓取</n-button>
    </div>

    <!-- 新增区域默认收起，点右上角「添加订阅」展开 -->
    <template v-if="showAdd">
      <SectionTitle title="添加订阅源" />
      <div class="set-field">
        <span class="set-field-key">名称</span>
        <n-input class="set-input-wide" size="small" v-model:value="newTitle" placeholder="例如：少数派 / 设计周刊（留空则用源站标题）" />
      </div>
      <div class="set-field">
        <span class="set-field-key">RSS / Atom 地址</span>
        <n-input class="set-input-wide" size="small" v-model:value="newUrl" placeholder="https://example.com/feed.xml" />
      </div>
      <div class="set-field">
        <span class="set-field-key">分组</span>
        <!-- 可选已有分组，也可直接输入新名字：保存时没命中的名字会当场建档 -->
        <n-select
          class="set-select"
          size="small"
          v-model:value="newGroup"
          :options="groupOptions"
          filterable
          tag
          clearable
          placeholder="选择或输入新分组，回车创建"
        />
      </div>
      <div class="set-field">
        <span class="set-field-key">抓取频率</span>
        <n-select class="set-select" size="small" v-model:value="newInterval" :options="sourceIntervalOptions" placeholder="跟随默认" />
      </div>
      <div class="set-actions">
        <n-button size="small" type="primary" :loading="busy === 'add'" @click="addSource">+ 添加订阅源</n-button>
      </div>
    </template>

    <n-modal v-model:show="showEdit" preset="card" class="set-modal" title="修改订阅源" :bordered="false">
      <n-form label-placement="left" :label-width="64" size="small">
        <n-form-item label="名称"><n-input v-model:value="editForm.title" placeholder="留空使用源站标题" /></n-form-item>
        <n-form-item label="链接"><n-input v-model:value="editForm.url" placeholder="https://example.com/feed.xml" /></n-form-item>
        <n-form-item label="分组">
          <n-select v-model:value="editForm.groupId" :options="groupOptions" clearable placeholder="未分组" />
        </n-form-item>
        <n-form-item label="频率">
          <n-select v-model:value="editForm.intervalMin" :options="intervalOptions" />
        </n-form-item>
      </n-form>
      <template #footer>
        <div class="set-inline set-inline-end">
          <n-button size="small" @click="showEdit = false">取消</n-button>
          <n-button size="small" type="primary" :loading="busy === 'edit'" @click="saveEdit">保存</n-button>
        </div>
      </template>
    </n-modal>
  </n-card>
</template>