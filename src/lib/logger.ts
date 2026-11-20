// 渲染进程日志：写入主进程日志文件。
// 无 IPC（浏览器预览）时降级到 console，不抛错。
import { hasBridge, bridge } from './ipc'

type Level = 'debug' | 'info' | 'warn' | 'error'

function emit(level: Level, scope: string, message: string, meta?: unknown) {
  const line = '[' + scope + '] ' + message
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')

  if (!hasBridge()) return
  // 上报失败不能影响业务：吞掉错误，只保证控制台可见
  void bridge()
    .log.write({ level, scope, message, meta })
    .catch(() => {})
}

export const log = {
  debug: (scope: string, message: string, meta?: unknown) => emit('debug', scope, message, meta),
  info: (scope: string, message: string, meta?: unknown) => emit('info', scope, message, meta),
  warn: (scope: string, message: string, meta?: unknown) => emit('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: unknown) => emit('error', scope, message, meta),

  /** 上报异常，带堆栈 */
  exception: (scope: string, err: unknown, info?: string) => {
    const e = err instanceof Error ? err : new Error(String(err))
    console.error('[' + scope + ']', e, info ?? '')
    if (!hasBridge()) return
    void bridge()
      .log.error({
        scope,
        message: e.message,
        stack: e.stack,
        info,
        location: typeof location !== 'undefined' ? location.hash : undefined
      })
      .catch(() => {})
  }
}
