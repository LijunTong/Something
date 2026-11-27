// 把更新流程里的原始错误翻成人能读懂的原因。
//
// 单独放在 lib 里而不是塞进组合式函数：这段是纯函数、没有 Vue 依赖，
// 可以直接用 esbuild 打包后在 Node 里跑断言（IPC 抛出的形态和运行时一致）。
export interface UpdateErrorText {
  code: string
  text: string
}

export function describeUpdateError(e: unknown): UpdateErrorText {
  const err = e as Error & { code?: string }
  const code = String(err?.code || '')
  const message = String(err?.message || '')
  if (code === 'NOT_PACKAGED') return { code, text: '开发模式不执行自动安装，请到发布页手动下载安装包' }
  if (code === 'NO_BRIDGE') return { code, text: '未在桌面应用中运行，无法检查更新' }
  // 主进程把 GitHub 的非 2xx 直接拼成 HTTP_<状态码>，既可能挂在 code 上也可能只在 message 里
  const http = /HTTP[_\s]?(\d{3})/.exec(code || message)
  if (http) {
    const status = Number(http[1])
    const shown = 'HTTP_' + status
    if (status === 401 || status === 403) return { code: shown, text: 'GitHub 接口拒绝访问（可能触发频率限制），请稍后重试' }
    if (status === 404) return { code: shown, text: '仓库还没有发布版本，请到发布页查看' }
    if (status >= 500) return { code: shown, text: 'GitHub 服务暂时不可用（' + status + '），请稍后重试' }
    return { code: shown, text: 'GitHub 接口返回异常（' + status + '）' }
  }
  if (/abort|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network|socket hang up/i.test(message)) {
    return { code: code || 'NETWORK', text: '网络不可达或连接超时，请检查网络或代理后重试' }
  }
  return { code: code || 'UPDATE_FAILED', text: message || '更新失败，请稍后重试' }
}
