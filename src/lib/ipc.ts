// IPC 调用封装。
//
// Illegal invocation 的根因：window.api 由 contextBridge 暴露，
// 其方法是绑定在原生对象上的；一旦被 Vue 的 reactive/ref 包住，
// 调用时 this 变成 Proxy，ipcRenderer.invoke 就会抛 Illegal invocation。
//
// 因此这里做了两件事：
// 1. 每次调用都从 window 现取原生对象，绝不复用被代理过的引用；
// 2. 通过 bind 固化原生对象为 this，即使调用方解构方法也不会丢。

export class IpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'IpcError'
  }
}

export const hasBridge = (): boolean =>
  typeof window !== 'undefined' && typeof window.api === 'object' && window.api !== null

/** 把桥对象里的方法全部 bind 到原生对象，杜绝 this 丢失 */
function bindAll<T extends object>(target: T): T {
  const out = {} as Record<string, unknown>
  for (const key of Object.keys(target)) {
    const value = (target as Record<string, unknown>)[key]
    if (typeof value === 'function') {
      out[key] = (value as (...args: unknown[]) => unknown).bind(target)
    } else if (value && typeof value === 'object') {
      out[key] = bindAll(value as object)
    } else {
      out[key] = value
    }
  }
  return out as T
}

let cached: typeof window.api | null = null

/** 取原生桥（已绑定 this）。只在首次访问时构造，之后复用。 */
export function bridge(): typeof window.api {
  if (cached) return cached
  cached = bindAll(window.api)
  return cached
}

/** 递归把响应式对象解包成纯 JSON 结构，避免 Proxy 穿过 IPC。 */
export function plain<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch (e) {
    return value
  }
}

export interface IpcEnvelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

/**
 * 统一调用入口。
 * invoke 必须是一个返回 Promise 的 thunk，内部只能用 bridge() 取原生对象。
 * 浏览器预览（无 preload 桥）时返回 fallback，让页面仍可渲染。
 */
export async function call<T>(invoke: () => Promise<IpcEnvelope<T>>, fallback?: T): Promise<T> {
  if (!hasBridge()) {
    if (fallback !== undefined) return fallback
    throw new IpcError('NO_BRIDGE', '未在 Electron 中运行，IPC 不可用')
  }
  const r = await invoke()
  if (!r || !r.ok) {
    throw new IpcError(r?.error?.code ?? 'IPC_FAILED', r?.error?.message ?? '调用失败')
  }
  return r.data as T
}
