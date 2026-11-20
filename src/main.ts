import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { useAppStore } from './stores/app'
import { log } from './lib/logger'
import './styles/index.css'

const app = createApp(App)
const pinia = createPinia()

// 全局错误兜底：把未捕获异常打到控制台并落到页面角标，
// 避免 Electron 把 'Illegal invocation' 之类直接弹成系统对话框。
app.config.errorHandler = (err, _instance, info) => {
  const msg = err instanceof Error ? err.message : String(err)
  log.exception('vue', err, info)
  window.dispatchEvent(new CustomEvent('app:error', { detail: { message: msg, info } }))
}
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason)
  log.exception('promise', e.reason, 'unhandledrejection')
  window.dispatchEvent(new CustomEvent('app:error', { detail: { message: msg, info: 'unhandledrejection' } }))
})
window.addEventListener('error', (e) => {
  log.exception('window', e.error ?? e.message, e.filename ? e.filename + ':' + e.lineno : 'resource')
})

app.use(pinia)
app.use(router)
app.mount('#app')

const store = useAppStore(pinia)
void store.init()
