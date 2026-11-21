/**
 * 网页邮箱地址：邮件页不再内置发信/回复，需要操作时跳到对应服务商官网。
 *
 * 只做「邮箱域名 → 登录入口」的静态映射，不发请求、不判断账号是否真实存在。
 * 未收录的域名按 https://mail.<域名>/ 兜底（多数企业邮 OWA/Exmail 都落在这里或可再重定向）。
 */

const SITE: Record<string, string> = {
  '163.com': 'https://mail.163.com/',
  '126.com': 'https://mail.126.com/',
  'yeah.net': 'https://mail.yeah.net/',
  '188.com': 'https://mail.188.com/',
  'qq.com': 'https://mail.qq.com/',
  'foxmail.com': 'https://mail.qq.com/',
  'exmail.qq.com': 'https://exmail.qq.com/',
  'gmail.com': 'https://mail.google.com/',
  'googlemail.com': 'https://mail.google.com/',
  'outlook.com': 'https://outlook.live.com/mail/0/',
  'hotmail.com': 'https://outlook.live.com/mail/0/',
  'live.com': 'https://outlook.live.com/mail/0/',
  'msn.com': 'https://outlook.live.com/mail/0/',
  'yahoo.com': 'https://mail.yahoo.com/',
  'sina.com': 'https://mail.sina.com.cn/',
  'sina.cn': 'https://mail.sina.com.cn/',
  'sohu.com': 'https://mail.sohu.com/',
  '139.com': 'https://mail.10086.cn/',
  'aliyun.com': 'https://mail.aliyun.com/',
  'icloud.com': 'https://www.icloud.com/mail/',
  'me.com': 'https://www.icloud.com/mail/',
  'proton.me': 'https://mail.proton.me/',
  'protonmail.com': 'https://mail.proton.me/'
}

/** 取邮箱域名，去掉可能的空白与尖括号；拿不到返回空串，由调用方提示。 */
function domainOf(email: string): string {
  const text = String(email || '').trim().replace(/^.*</, '').replace(/>.*$/, '')
  const at = text.lastIndexOf('@')
  if (at < 0 || at === text.length - 1) return ''
  return text.slice(at + 1).toLowerCase().trim()
}

/** 域名 → 网页邮箱登录地址；域名缺失时返回空串。 */
export function webmailUrl(email: string): string {
  const domain = domainOf(email)
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) return ''
  return SITE[domain] || 'https://mail.' + domain + '/'
}
