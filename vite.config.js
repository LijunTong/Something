import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import { fileURLToPath, URL } from 'node:url'
import { transformSync } from 'esbuild'

// 本机 esbuild 服务无法清理系统临时文件（Access denied），
// 这里用 transformSync 在进程内直接转译 TS，不走 serve 通道。
function tsInline() {
  return {
    name: 'ts-inline-transform',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.ts') || id.endsWith('.d.ts')) return null
      const out = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2022', sourcemap: true, sourcefile: id })
      return { code: out.code, map: null }
    }
  }
}

// chokidar 在 Windows 上监听到被占用的文件时会 emit 'error'（EBUSY）。
// 没有监听器时 Node 会把它升级成未捕获异常，直接打死 dev server —— 这里接住并降级为警告。
function watchErrorGuard() {
  return {
    name: 'watch-error-guard',
    apply: 'serve',
    configureServer(server) {
      const report = function (err) {
        server.config.logger.warn('[watch] 忽略一次监听失败：' + ((err && err.code) || '') + ' ' + ((err && err.path) || ''))
      }
      if (server.watcher && typeof server.watcher.on === 'function') server.watcher.on('error', report)
    }
  }
}

export default defineConfig({
  plugins: [
    tsInline(),
    vue(),
    Components({ dts: false, resolvers: [NaiveUiResolver()], dirs: [] }),
    watchErrorGuard()
  ],
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  esbuild: false,
  build: { minify: false, target: 'es2022' },
  server: {
    port: 5173,
    strictPort: false,
    // TK_HMR=0 时彻底关掉渲染层热更新（页面不再自动刷新，改动后手动 F5）。
    // 默认保留 HMR：只换模块，不重启窗口、不抢焦点。
    hmr: process.env.TK_HMR === '0' ? false : undefined,
    // 数据目录回退到 <项目>/.data 时，SQLite 会持续改写 -wal/-shm；
    // 不忽略会触发无意义的 watcher 事件。
    // TK_POLL=1 时改用 mtime 轮询：Windows 上原子写/同步盘/杀软会让 fs 事件丢失，
    // 表现为「改了文件但页面还是旧的」，轮询可兜底（开发期代价可接受）。
    // 忽略数据目录与「原子写」产生的临时文件：编辑工具会先在同目录建 .xxx.tmpdir/x.tmp 再改名，
    // chokidar 去 watch 这些被占用的临时文件会抛 EBUSY，未捕获时整个 dev server 直接挂掉。
    watch: {
      // assets/ 下可能出现运行时生成的图标缓存，一并排除，避免被占用时又触发 EBUSY
      ignored: ['**/.data/**', '**/*.tmpdir/**', '**/.*.tmpdir/**', '**/*.tmp', '**/.~*', 'assets/**'],
      usePolling: process.env.TK_POLL === '1',
      interval: 300
    }
  }
})
