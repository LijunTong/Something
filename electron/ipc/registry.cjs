// IPC 注册器：统一 zod 校验 + 错误规范化 + 写后广播。
const { ipcMain } = require('electron')
const logger = require('../log/logger.cjs')

function wrap(handler, schema, channel) {
  return async function (_event, payload) {
    const started = Date.now()
    try {
      let input = payload
      if (schema && schema.safeParse) {
        const parsed = schema.safeParse(payload)
        if (!parsed.success) {
          const detail = parsed.error.issues.map(function (i) { return i.path.join('.') + ': ' + i.message }).join('; ')
          logger.warn('ipc', 'invalid_input', { channel: channel, detail: detail })
          return { ok: false, error: { code: 'INVALID_INPUT', message: detail } }
        }
        input = parsed.data
      }
      const data = await handler(input)
      logger.debug('ipc', 'ok', { channel: channel, ms: Date.now() - started })
      return { ok: true, data: data }
    } catch (err) {
      const code = err && err.code ? err.code : (err && err.message) || 'INTERNAL_ERROR'
      // IPC 是异常最集中的地方，完整记录入参与堆栈（logger 会自动脱敏）
      logger.error('ipc', 'handler_failed', err, { channel: channel, payload: payload, ms: Date.now() - started })
      return { ok: false, error: { code: String(code), message: String((err && err.message) || err) } }
    }
  }
}

function createRegistry() {
  const channels = []

  function register(domain, methods, opts) {
    const options = opts || {}
    for (const name in methods) {
      const def = methods[name]
      // 防御：注册了不存在的方法时不能让整个主进程崩溃（会让窗口永远不出现）。
      // 跳过并记录日志，其余域照常注册。
      if (!def || (typeof def !== 'function' && typeof def.handler !== 'function')) {
        logger.error('ipc', 'missing_handler', undefined, { channel: domain + ':' + name })
        continue
      }
      const fn = typeof def === 'function' ? def : def.handler
      const schema = typeof def === 'function' ? null : def.schema
      const channel = domain + ':' + name
      ipcMain.handle(channel, wrap(fn, schema, channel))
      channels.push(channel)
    }
  }

  /** 主进程写操作后广播，渲染进程据此刷新对应域。 */
  function broadcast(webContents, domain, action) {
    if (!webContents || webContents.isDestroyed()) return
    webContents.send('data:changed', { domain: domain, action: action, at: Date.now() })
  }

  return { register: register, broadcast: broadcast, channels: function () { return channels.slice() } }
}

module.exports = { createRegistry: createRegistry }
