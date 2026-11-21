<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NTag, NEmpty, NSpin, NButton } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { MailAccount, MailRow } from '@/types/api'

const router = useRouter()
const rows = ref<MailRow[]>([])
const accounts = ref<MailAccount[]>([])
const loading = ref(false)

function hhmm(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay
    ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    : (d.getMonth() + 1) + '/' + d.getDate()
}

function accountName(id: string): string {
  const a = accounts.value.find((x) => x.id === id)
  return a ? a.alias || a.email : '本地账户'
}

const list = computed(() => {
  const sorted = [...rows.value].sort((a, b) => Number(b.important) - Number(a.important) || (b.sentAt || 0) - (a.sentAt || 0))
  return sorted.slice(0, 3)
})
const unread = computed(() => rows.value.length)
const lastSync = computed(() => {
  const t = accounts.value.reduce((s, a) => Math.max(s, a.lastSyncAt || 0), 0)
  return t ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '未同步'
})

async function load() {
  if (!hasBridge()) return
  loading.value = true
  try {
    const [list_, accts] = await Promise.all([
      call(() => bridge().mail.list({ unread: true }), [] as MailRow[]),
      call(() => bridge().mail.accounts(), [] as MailAccount[])
    ])
    rows.value = list_
    accounts.value = accts
  } catch (e) {
    log.exception('home.mail', e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
const refreshTick = useHomeCardRefresh('mail')
watch(refreshTick, () => { void load() })
</script>

<template>
  <n-card size="small" class="hc-card hc-card-mail">
    <template #header>
      <div class="hc-head">
        <span>邮件 · 未读 {{ unread }}</span>
        <n-tag size="tiny" :type="accounts.length ? 'success' : 'warning'">
          {{ accounts.length ? accounts.length + ' 个账户' : '未配置账户' }}
        </n-tag>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <n-button size="tiny" quaternary @click="router.push('/mail')">打开收件箱</n-button>
          <HomeCardMenu module="mail" />
        </div>
      </template>

    <n-spin :show="loading">
      <n-empty
        v-if="!accounts.length"
        size="small"
        description="还没有配置邮箱账户，去设置里添加"
      >
        <n-button size="tiny" @click="router.push('/settings?panel=mail')">添加邮箱账户</n-button>
      </n-empty>
      <n-empty v-else-if="!list.length" size="small" description="没有未读邮件" />
      <div v-for="m in list" :key="m.id" class="hc-mail-row">
        <span class="hc-mail-main">
          <strong>{{ m.subject || '（无主题）' }}</strong>
          <small class="hc-muted">
            {{ m.fromName || m.fromAddr || '未知发件人' }} · {{ accountName(m.accountId) }}
            <template v-if="m.hasAttach"> · 含附件</template>
          </small>
        </span>
        <n-tag v-if="m.important" size="tiny" type="warning">重要</n-tag>
        <n-tag v-else size="tiny">通知</n-tag>
        <time class="hc-mail-time">{{ hhmm(m.sentAt) }}</time>
      </div>
    </n-spin>

    <template #footer>
      <span class="hc-muted">最近同步 {{ lastSync }} · 认证信息本地加密保存</span>
    </template>
  </n-card>
</template>