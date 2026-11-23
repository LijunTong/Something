<script setup lang="ts">
// Agent 接入：本机 MCP 服务的开关、端口、访问令牌与客户端配置片段。
// 服务只监听 127.0.0.1，写入的令牌由主进程生成，这里按需回显，不进入设置对象。
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NInput, NInputNumber, NSwitch, NTabPane, NTabs, NTag, NText, useDialog, useMessage } from 'naive-ui'
import SectionTitle from '@/components/settings/SectionTitle.vue'
import { call, bridge, hasBridge } from '@/lib/ipc'
import { log } from '@/lib/logger'
import type { McpStatus } from '@/types/api'

const message = useMessage()
const dialog = useDialog()

const status = ref<McpStatus | null>(null)
const port = ref(3927)
const token = ref('')
const busy = ref(false)

const running = computed(() => !!status.value && status.value.enabled && !!status.value.endpoint)
const endpoint = computed(() => (running.value && status.value ? status.value.endpoint : '') || '')
// 环境变量优先时端口由进程环境决定，设置里改了也不会生效，直接锁住避免误解
const envLocked = computed(() => status.value?.portSource === 'env')
const portHint = computed(() => {
  if (status.value?.portSource === 'env') return '由环境变量 TK_MCP_PORT 指定，设置里改不了'
  if (status.value?.portSource === 'setting') return '使用设置里保存的端口；被占用时不会自动换端口'
  return '未手动指定：开发版默认 3927、安装版默认 3928；被占用时不会自动换端口'
})
const mcpUrl = computed(() => endpoint.value || 'http://127.0.0.1:' + (status.value?.port || port.value) + '/mcp')
const configText = computed(() => {
  const url = mcpUrl.value
  return JSON.stringify({
    mcpServers: {
      'something-plan': {
        type: 'http',
        url: url,
        headers: { Authorization: 'Bearer ' + (token.value || '<点击下方「显示令牌」后填入>') }
      }
    }
  }, null, 2)
})
// DeepSeek Harness 的 MCP 客户端是 cordis 插件，配置写在 profile 的 cordis.patch.yml 里，不是 mcpServers JSON
const dshConfigText = computed(() => {
  const tokenText = token.value || '<点击上方「显示令牌」后替换>'
  return [
    '- insert:',
    '    - id: something-plan',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: something-plan',
    '        transport: streamable-http',
    '        url: ' + mcpUrl.value,
    '        headers:',
    '          Authorization: Bearer ' + tokenText,
    '        reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 30 }'
  ].join('\n')
})

async function refresh() {
  if (!hasBridge()) return
  try {
    const next = await call(() => bridge().mcp.status(), null as McpStatus | null)
    if (next) {
      status.value = next
      port.value = next.port || 3927
    }
  } catch (e) {
    log.exception('settings.mcp.status', e)
  }
}

async function setEnabled(enabled: boolean, withPort = false) {
  if (busy.value) return
  busy.value = true
  try {
    // 只切开关时不回传端口，避免把「按环境默认」悄悄固化成设置值
    const dto = withPort ? { enabled, port: Number(port.value) } : { enabled }
    const next = await call(() => bridge().mcp.setEnabled(dto), null as McpStatus | null)
    if (next) status.value = next
    if (next && next.enabled && !next.endpoint) {
      message.error(next.lastError || '服务未能启动，请检查端口是否被占用')
    } else {
      message.success(enabled ? '已开启本机 MCP 服务' : '已关闭本机 MCP 服务')
    }
  } catch (e) {
    log.exception('settings.mcp.toggle', e)
    message.error('切换失败：' + ((e as Error).message || '未知错误'))
  } finally {
    busy.value = false
  }
}

async function applyPort() {
  if (envLocked.value) return
  const p = Number(port.value)
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    message.error('端口需在 1024-65535 之间')
    return
  }
  const enabled = !!status.value?.enabled
  await setEnabled(enabled, true)
}

async function revealToken() {
  try {
    const out = await call(() => bridge().mcp.revealToken(), { token: '' })
    token.value = out.token
  } catch (e) {
    log.exception('settings.mcp.reveal', e)
    message.error('读取令牌失败：' + ((e as Error).message || '未知错误'))
  }
}

async function copy(text: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制')
  } catch (e) {
    log.exception('settings.mcp.copy', e)
    message.error('复制失败，请手动选中复制')
  }
}

function rotate() {
  dialog.warning({
    title: '重新生成令牌',
    content: '旧令牌会立即失效，已经接好的 Agent 需要重新配置。',
    positiveText: '重新生成',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const out = await call(() => bridge().mcp.rotateToken(), { token: '' })
        token.value = out.token
        await refresh()
        message.success('已生成新令牌')
      } catch (e) {
        log.exception('settings.mcp.rotate', e)
        message.error('生成失败：' + ((e as Error).message || '未知错误'))
      }
    }
  })
}

function fmtAt(ts: number | null): string {
  if (!ts) return '尚未调用'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

onMounted(() => { void refresh() })
</script>

<template>
  <n-card size="small" title="Agent 接入">
    <template #header-extra>
      <n-tag size="small" :type="running ? 'success' : 'default'">{{ running ? '运行中' : '未启动' }}</n-tag>
    </template>

    <p class="set-muted">
      开启后在本机 127.0.0.1 上提供一个 MCP 服务，Agent 可把项目计划写成待办与子任务。服务不对外网开放，关闭开关立即停止监听。
    </p>

    <SectionTitle title="本机服务" />
    <div class="set-field">
      <span class="set-field-key">
        启用 MCP 服务
        <small class="set-hint">只监听回环地址，不经过任何云端</small>
      </span>
      <n-switch :value="!!status?.enabled" :loading="busy" @update:value="(v: boolean) => setEnabled(v)" />
    </div>
    <div class="set-field">
      <span class="set-field-key">
        端口
        <small class="set-hint">{{ portHint }}</small>
      </span>
      <span class="set-inline">
        <n-input-number v-model:value="port" class="set-port" size="small" :min="1024" :max="65535" :step="1" :disabled="envLocked" />
        <n-button size="small" :disabled="busy || envLocked" @click="applyPort">应用</n-button>
      </span>
    </div>
    <div class="set-field">
      <span class="set-field-key">服务地址</span>
      <n-text depth="3" class="set-field-value">{{ endpoint || '—' }}</n-text>
    </div>
    <div class="set-field">
      <span class="set-field-key">最近调用</span>
      <n-text depth="3" class="set-field-value">{{ fmtAt(status?.lastCallAt ?? null) }}{{ status?.lastTool ? ' · ' + status.lastTool : '' }}</n-text>
    </div>
    <n-alert v-if="status?.lastError" type="warning" :bordered="false" class="mcp-alert">{{ status.lastError }}</n-alert>

    <SectionTitle title="访问令牌" />
    <div class="set-field">
      <span class="set-field-key">
        Bearer Token
        <small class="set-hint">每个请求都需要它；令牌只保存在本机数据库</small>
      </span>
      <span class="set-inline">
        <n-button size="small" @click="revealToken">显示令牌</n-button>
        <n-button size="small" @click="copy(token)">复制</n-button>
        <n-button size="small" type="warning" ghost @click="rotate">重新生成</n-button>
      </span>
    </div>
    <div v-if="token" class="mcp-block">
      <n-input :value="token" type="text" readonly size="small" />
    </div>

    <SectionTitle title="客户端配置" />
    <n-tabs type="line" animated>
      <n-tab-pane name="generic" tab="通用 MCP 客户端">
        <p class="set-muted">把下面的片段加到支持 Streamable HTTP 的 MCP 客户端配置里；先点「显示令牌」替换占位符。</p>
        <div class="mcp-block">
          <n-input :value="configText" type="textarea" readonly :autosize="{ minRows: 6, maxRows: 12 }" />
          <div class="mcp-row">
            <n-button size="small" @click="copy(configText)">复制配置</n-button>
            <n-text depth="3">工具：project_plan_write / project_plan_read / project_plan_item_update / project_plan_list</n-text>
          </div>
        </div>
      </n-tab-pane>
      <n-tab-pane name="dsh" tab="DeepSeek Harness">
        <p class="set-muted">
          DeepSeek Harness 通过 cordis 插件接入：把下面的条目追加到 <code>%USERPROFILE%\.dsh\profiles\&lt;profile&gt;\cordis.patch.yml</code>，重启 Harness 生效。
          已有同 id 条目时改 id 或直接改现有条目。
        </p>
        <div class="mcp-block">
          <n-input :value="dshConfigText" type="textarea" readonly :autosize="{ minRows: 9, maxRows: 14 }" />
          <div class="mcp-row">
            <n-button size="small" @click="copy(dshConfigText)">复制配置</n-button>
            <n-text depth="3">transport 为 streamable-http；令牌放在 headers.Authorization</n-text>
          </div>
        </div>
      </n-tab-pane>
    </n-tabs>
  </n-card>
</template>
