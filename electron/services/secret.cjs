// 凭据存取（天气 API Key / JWT 私钥 / 邮箱授权码）。
// 按需求改为明文落库：设置页默认掩码显示，用户可切换明文查看。
// 兼容旧版本：早期用 safeStorage 加密后存 base64 密文（settings 存的是再套一层 JSON 字符串），
// 读取时自动解密返回明文，用户下次保存即写回明文。

/** 解出旧版密文；不是密文或解密失败返回 null */
function legacyDecrypt(text) {
  const s = String(text || '')
  if (!s || s.length < 24) return null
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return null
  try {
    const safeStorage = require('electron').safeStorage
    if (!safeStorage || typeof safeStorage.decryptString !== 'function') return null
    const plain = safeStorage.decryptString(Buffer.from(s, 'base64'))
    return plain == null ? null : String(plain)
  } catch (e) {
    return null
  }
}

/** 读取任意存储形态的凭据，统一返回明文 */
function unpack(raw) {
  if (raw == null) return ''
  let s = String(raw).trim()
  if (!s) return ''
  // 新格式：JSON.stringify({ plain })
  if (s.charAt(0) === '{') {
    try {
      const obj = JSON.parse(s)
      if (obj && typeof obj.plain === 'string') return obj.plain
    } catch (e) { /* 落回下面的兼容分支 */ }
  }
  // 旧格式之一：JSON.stringify(base64)
  if (s.charAt(0) === '"') {
    try {
      const v = JSON.parse(s)
      if (typeof v === 'string') s = v
    } catch (e) { /* 不是合法 JSON 就当普通文本 */ }
  }
  const legacy = legacyDecrypt(s)
  return legacy == null ? s : legacy
}

/** 明文落库格式；外层 JSON 便于与旧密文区分 */
function pack(plain) {
  return JSON.stringify({ plain: String(plain == null ? '' : plain) })
}

module.exports = { pack: pack, unpack: unpack, legacyDecrypt: legacyDecrypt }
