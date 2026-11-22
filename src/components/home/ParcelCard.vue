<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NEmpty, NSpin, NButton, NModal, NForm, NFormItem, NInput, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import { triggerHomeRefresh } from '@/composables/useHomeRefresh'
import type { ParcelRow } from '@/types/api'

const router = useRouter()
const message = useMessage()
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
/** 新增单号：入口在卡片菜单里，弹窗内一次贴多个号，不跳快递页 */
const showCreate = ref(false)
const saving = ref(false)
const form = ref({ numbers: '', note: '' })

function openCreate() {
  form.value = { numbers: '', note: '' }
  showCreate.value = true
}
function onMenu(key: string) {
  if (key === 'create') void openCreate()
}
async function submitCreate() {
  const numbers = form.value.numbers.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
  if (!numbers.length) { message.warning('先填快递单号'); return }
  saving.value = true
  try {
    await call(() => bridge().parcel.add({ numbers, note: form.value.note || undefined }))
    message.success('已添加 ' + numbers.length + ' 个单号')
    showCreate.value = false
    await load()
    triggerHomeRefresh('parcel')
  } catch (e) {
    message.error('添加失败：' + ((e as Error).message || '未知错误'))
  } finally {
    saving.value = false
  }
}

onMounted(load)
const refreshTick = useHomeCardRefresh('parcel')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-parcel">
    <template #header>
      <div class="hc-head">
        <!-- 只有标题文字进快递页，卡片其它区域不跳转 -->
        <n-button text size="small" @click="router.push('/parcel')">快递</n-button>
        <span class="hc-status"><i class="hc-dot" :class="pendingPickup ? 'is-warn' : 'is-info'" />{{ pendingPickup ? pendingPickup + ' 个待取件' : rows.length + ' 个在途' }}</span>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <HomeCardMenu module="parcel" :actions="[{ label: '新增单号', key: 'create' }]" @action="onMenu" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty v-if="!list.length" size="small" description="没有在途包裹" />
      <div
        v-for="p in list"
        :key="p.id"
        class="hc-parcel-row hc-row-link"
        role="button"
        tabindex="0"
        @click="router.push({ path: '/parcel', query: { focus: p.id } })"
        @keydown.enter="router.push({ path: '/parcel', query: { focus: p.id } })"
      >
        <svg class="hc-ico" viewBox="0 0 24 24"><use :href="p.status === '待取件' ? '#i-box' : '#i-truck'" /></svg>
        <span class="hc-parcel-main">
          <strong>{{ p.company }}</strong>
          <small class="hc-muted">
            {{ p.status === '待取件' ? (p.pickupCode ? '取件码 ' + p.pickupCode : '待取件') : '预计 ' + dateText(p.etaAt) + ' 送达' }}
            <template v-if="p.station"> · {{ p.station }}</template>
          </small>
        </span>
        <span class="hc-status"><i class="hc-dot" :class="p.status === '待取件' ? 'is-warn' : 'is-info'" />{{ p.status }}</span>
      </div>
    </n-spin>

    <template #footer>
      <span class="hc-muted">最近刷新 {{ refreshedAt ? new Date(refreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—' }} · 数据已缓存至本机</span>
    </template>
  </n-card>

  <n-modal v-model:show="showCreate" to="body" preset="card" style="width:460px" title="新增快递单号">
    <n-form label-placement="left" :label-width="60">
      <n-form-item label="单号">
        <n-input
          v-model:value="form.numbers"
          type="textarea"
          :rows="4"
          placeholder="一个号一行，也支持逗号、空格分隔，一次可贴多个"
        />
      </n-form-item>
      <n-form-item label="备注">
        <n-input v-model:value="form.note" placeholder="可选，例如「给同事的」" />
      </n-form-item>
    </n-form>
    <template #footer>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <n-button size="small" @click="showCreate = false">取消</n-button>
        <n-button size="small" type="primary" :loading="saving" @click="submitCreate">保存</n-button>
      </div>
    </template>
  </n-modal>
</template>