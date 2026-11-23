// 订阅源图标：默认取源站根目录的 favicon.ico，取不到时由 NAvatar 的 fallback 插槽显示首字占位。
// 只拼地址不做网络请求，图片加载失败交给组件处理，避免渲染进程额外抓取页面。

/** 源站图标地址；非 http(s) 链接返回空串，由调用方回退到首字 */
export function siteIconUrl(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.origin + '/favicon.ico'
  } catch {
    return ''
  }
}

/** 图标不可用时的占位字：优先名称首字，其次域名首字 */
export function siteInitial(name: string | null | undefined, url?: string | null): string {
  const label = (name || '').trim()
  if (label) return label[0].toUpperCase()
  try {
    const host = new URL(url || '').hostname.replace(/^www\./, '')
    return (host[0] || '?').toUpperCase()
  } catch {
    return '?'
  }
}
