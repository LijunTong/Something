<script setup lang="ts">
import { useHomeCardRefresh } from '@/composables/useHomeRefresh'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import HomeCardMenu from '@/components/home/HomeCardMenu.vue'
import { NCard, NEmpty, NSpin, NButton, useMessage } from 'naive-ui'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { MailAccount, MailRow } from '@/types/api'

const router = useRouter()
const message = useMessage()
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
/** 同步收件箱：入口在卡片菜单里，直接在卡片所在页拉取，不跳邮件页 */
const syncing = ref(false)
function onMenu(key: string) {
  if (key === 'sync') void syncMail()
}
async function syncMail() {
  if (!accounts.value.length) {
    message.warning('还没有配置邮箱账户，先去设置里添加')
    return
  }
  // 只同步启用的账户：停用的账户留在列表里供查看，但不去连服务器
  const targets = accounts.value.filter((a) => a.enabled !== false)
  if (!targets.length) {
    message.warning('没有启用的邮箱账户，先去设置里启用')
    return
  }
  syncing.value = true
  try {
    let added = 0
    for (const a of targets) {
      const r = await call(() => bridge().mail.sync({ accountId: a.id, limit: 30 }), { ok: true, accountId: a.id, added: 0, updated: 0, total: 0 })
      added += r?.added ?? 0
    }
    message.success('同步完成，新增 ' + added + ' 封')
    await load()
  } catch (e) {
    log.exception('home.mail.sync', e)
    message.error('同步失败：' + ((e as Error).message || '未知错误'))
  } finally {
    syncing.value = false
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
        <!-- 只有标题文字进邮件页，卡片其它区域不跳转 -->
        <n-button text size="small" @click="router.push('/mail')">邮件 · 未读 {{ unread }}</n-button>
        <span class="hc-status">
          <i class="hc-dot" :class="accounts.length ? 'is-ok' : 'is-warn'" />{{ accounts.length ? accounts.length + ' 个账户' : '未配置账户' }}
        </span>
      </div>
    </template>
    <template #header-extra>
        <div class="hc-head-actions">
          <HomeCardMenu module="mail" :actions="[{ label: '同步收件箱', key: 'sync' }]" @action="onMenu" />
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
      <div
        v-for="m in list"
        :key="m.id"
        class="hc-mail-row hc-row-link"
        role="button"
        tabindex="0"
        @click="router.push({ path: '/mail', query: { focus: m.id } })"
        @keydown.enter="router.push({ path: '/mail', query: { focus: m.id } })"
      >
        <span class="hc-mail-main">
          <strong>{{ m.subject || '（无主题）' }}</strong>
          <small class="hc-muted">
            {{ m.fromName || m.fromAddr || '未知发件人' }} · {{ accountName(m.accountId) }}
            <template v-if="m.hasAttach"> · 含附件</template>
          </small>
        </span>
        <span v-if="m.important" class="hc-status"><i class="hc-dot is-warn" />重要</span>
        <span v-else class="hc-status"><i class="hc-dot" />通知</span>
        <time class="hc-mail-time">{{ hhmm(m.sentAt) }}</time>
      </div>
    </n-spin>

    <template #footer>
      <span class="hc-muted">最近同步 {{ lastSync }} · 认证信息本地加密保存</span>
    </template>
  </n-card>

</template>