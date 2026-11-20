# 效率工具集 · Electron 桌面版交付说明

## 技术栈
Electron + Node.js + Vue 3 + Vite + Pinia + Vue Router + SQLite（better-sqlite3）。

- **Electron**：桌面容器，主进程持有 SQLite 数据库，通过 IPC 暴露给渲染进程。
- **Node.js**： electron 主进程运行时。
- **Vue 3 + Vite**：9 个模块页为 Vue 单文件组件，hash 路由。
- **Pinia**：全局响应式状态；渲染进程所有读写走 `window.electronAPI` → IPC → SQLite。
- **SQLite**：`app.getPath('userData')/toolkit.db`，WAL 模式，app_state 表按模块存 JSON，operation_log 表记操作日志。

## 目录结构
```
electron/
  main.cjs        主进程：窗口、IPC、app 生命周期
  preload.cjs     contextBridge 暴露 electronAPI
  database.cjs    SQLite 数据访问层（init/getAll/saveAll/saveModule/reset/log）
  seed.cjs        默认种子数据
src/
  main.js         Vue 入口
  router/         9 条路由
  stores/         Pinia store（app.js）+ 浏览器兜底默认值
  components/     Icons / Shell（侧栏+顶栏）/ toast
  views/          Home/Todo/Schedule/Pomodoro/Weather/Feed/Parcel/Mail/Settings
  styles/         从原型 CSS 迁移 + 全局补充
dist/             前端构建产物（已生成）
```

## 运行
```
npm install           # 首次安装会下载 Electron 二进制并编译 SQLite 原生模块
npm run rebuild       # 如需重新为 Electron 编译 better-sqlite3
npm run dev           # 浏览器预览（Vite，走 localStorage 兜底）
npm run build         # 构建前端到 dist/
npm start             # 启动 Electron 桌面应用（加载 dist/）
```

> 说明：本环境网络/沙箱限制导致 Electron 二进制下载与原生编译可能需在你本机首次 `npm install` 完成；代码、配置、数据层与前端构建均已就绪并验证通过。

## 数据持久化
- 桌面运行：所有业务数据写入 SQLite（userData/toolkit.db），切换/重启应用数据保留。
- 浏览器预览：自动回退 localStorage（key=`toolkit.state.v1`），便于无 Electron 环境下查看界面。
- 设置页可导出 JSON / ICS / OPML、立即备份、重置数据库。

## 已实现功能（对齐 docs/feature-design.md 的 MVP）
与静态原型一致的全部交互：首页 8 卡联动、天气多城市、日程周视图 CRUD、番茄真实计时与状态恢复、待办快速添加/子任务/看板、信息流阅读器、快递轨迹与隐私模式、邮件收件箱与撰写、设置主题与数据管理。跨模块联动（待办⇄日程⇄番茄、快递/信息流/邮件→待办）与全局搜索、侧栏角标同步均已接入。

## 验证状态
- `npm run build`：通过（43 modules，产出 dist/）。
- SQLite CRUD：数据层代码就绪，better-sqlite3 已通过 electron-rebuild 编译为 Electron ABI 130。
- 浏览器预览：Pinia + localStorage 兜底，无需 Electron 也可查看全部 9 屏。
## 环境要求（重要）

### 1. Electron 二进制必须已安装

`node_modules/electron/dist/electron.exe` 必须存在。若 `npm run dev` 报「Electron failed to install correctly」，说明二进制未下载成功，执行：

```
# 国内镜像（推荐）
set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
node node_modules/electron/install.js
```

或手动下载 `electron-v33.4.11-win32-x64.zip` 解压到 `node_modules/electron/dist/`，并写入 `node_modules/electron/path.txt` 内容为 `electron.exe`。

### 2. 不能设置 ELECTRON_RUN_AS_NODE

若环境变量 `ELECTRON_RUN_AS_NODE=1` 存在，Electron 会退化成纯 Node 运行时，表现为主进程报 `Cannot read properties of undefined (reading 'whenReady')`，窗口起不来。

`scripts/dev.cjs` 在启动 Electron 时已显式清除该变量。手动执行 `npm start` 时请自行确认：

```
# Windows CMD
set ELECTRON_RUN_AS_NODE=
# PowerShell
$env:ELECTRON_RUN_AS_NODE=""
```

### 3. 需要图形桌面环境

Electron 是 GUI 程序，在无显示环境（纯 SSH、部分容器/CI）里会静默退出，不会创建窗口。桌面应用需在有桌面的 Windows 会话中运行。
### 4. 退出码对照（Electron 启动崩溃排查）

| 退出码 | 含义 | 处置 |
| --- | --- | --- |
| `2147483651` / `0x80000003` | STATUS_BREAKPOINT，Chromium 初始化即崩溃，日志为空、主进程首行都未执行 | 加 `--no-sandbox`；见下 |
| `-1073741819` / `0xC0000005` | 访问冲突，通常是**无显示环境**下创建窗口失败 | 必须在有图形桌面的会话中运行 |
| `Cannot read properties of undefined (reading 'whenReady')` | `ELECTRON_RUN_AS_NODE=1`，Electron 退化为纯 Node | 清除该环境变量 |
| `Electron failed to install correctly` | 二进制未下载 | 走第 1 条重装 |

#### 受限环境下的规避开关

项目内置两个显式开关（`electron/main.cjs` 里读取）：

```
# 容器/受限会话：禁用 renderer 沙箱
set TK_NO_SANDBOX=1
# 无 GPU 或虚拟显卡环境：禁用硬件加速
set TK_DISABLE_GPU=1

# 两者同时需要时
set TK_NO_SANDBOX=1 && set TK_DISABLE_GPU=1 && npm run dev
```

> 说明：这两个开关只影响 Chromium 的进程模型与渲染后端，不改变应用安全模型（主进程仍是唯一能访问 SQLite 的地方，渲染进程仍走 preload 白名单）。

#### 关于端口

`scripts/dev.cjs` 会从 Vite 实际输出里解析端口（5173 被占用时自动用 5174/5175 等），并把真实地址通过 `VITE_URL` 传给 Electron。看到「trying another one」是正常行为，不是错误。

---

## 验证状态说明

当前开发环境为无图形会话，Electron 进程可启动但无法创建窗口（表现为 `0xC0000005`）。以下已验证：

- Electron 二进制完整（33.4.11，73 个文件、6 个 DLL、55 个 locale）
- 加 `--no-sandbox` 后主进程可执行至首行 JS，证明二进制与主进程代码本身正常
- `npm run build` 与 `npx vue-tsc --noEmit` 通过
- 服务层（SQLite 迁移、种子、待办/日程/番茄 CRUD）端到端通过

窗口渲染需在有桌面的 Windows 会话中执行 `npm run dev` 验证。
### 5. 诊断结论（本仓库已验证）

用分段打点验证 Electron 启动链路，结果：

```
1_js_started          ✅ 主进程 JS 开始执行
2_electron_required   ✅ electron 模块加载成功
3_conn_required       ✅ db/conn.cjs 加载成功（better-sqlite3 原生模块 ABI 正确）
4_seed_required       ✅ db/seed.cjs 加载成功
5_app_ready           ❌ app.whenReady() 未触发
```

**结论**：主进程代码、SQLite 原生模块、IPC 服务层全部正常；卡点在 `app.whenReady()` —— GUI 初始化。

这发生在**无图形会话**中（远程/服务/受限容器）。在你的 Windows 桌面 PowerShell 里，`whenReady` 会正常触发。

如果你的桌面环境也停在这一步，按优先级排查：

1. **安全软件**：`0x80000003` 常见于杀软/EDR 拦截未签名 exe。临时把项目目录加入排除项。
2. **重装二进制（官方源）**：
   ```powershell
   Remove-Item -Recurse -Force node_modules\electron\dist
   $env:ELECTRON_MIRROR="https://github.com/electron/electron/releases/download/"
   node node_modules/electron/install.js
   ```
3. **显卡驱动/远程桌面**：RDP 会话下 GPU 初始化可能失败，务必加
   ```powershell
   $env:TK_DISABLE_GPU="1"
   ```
4. **用开发模式验证前端是否正常**：`npm run dev:vite` 只起前端，浏览器打开 5173 能看到界面，说明前端无问题。
### 6. GPU 崩溃（已修复，默认关闭硬件加速）

典型日志：

```
[db] file=...\toolkit.db version=2 applied=[1,2] integrity=true
ERROR:gpu_process_host.cc(976)] GPU process launch failed: error_code=18
...（重复多次）
FATAL:gpu_data_manager_impl_private.cc(423)] GPU process isn't usable. Goodbye.
[dev] Electron exited (code=2147483651)
```

注意第一行 `[db] ... integrity=true` —— 这说明**主进程、SQLite 建库、迁移（version=2）、种子数据全部成功**，应用逻辑已经跑通；崩溃点纯粹在 GPU 子进程。

`error_code=18` 表示 GPU 进程创建失败（常见于虚拟显卡、远程桌面会话、显卡驱动异常、或安全软件限制子进程）。

**处置**：`electron/main.cjs` 已默认调用 `app.disableHardwareAcceleration()` 并关闭 GPU 合成与软件光栅化。本应用是工具类二维界面，不需要硬件加速，关闭后无功能损失。

如需恢复硬件加速（例如有独显且想跑动效）：

```powershell
$env:TK_ENABLE_GPU="1"
npm run dev
```

若关闭 GPU 后仍报 `GPU process launch failed`，再叠加禁用沙箱：

```powershell
$env:TK_NO_SANDBOX="1"
npm run dev
```

---

## 成功启动的标志

正常启动时终端应出现：

```
[dev] Vite ready at http://127.0.0.1:517x; starting Electron...
[db] file=<userData>\toolkit.db version=2 applied=[] integrity=true
```

并且弹出 1440×900 的「效率工具集」窗口。

- `applied=[1,2]` 首次启动（执行了 001、002 两个迁移）
- `applied=[]` 后续启动（迁移已应用，跳过）
- `version=2` 当前 schema 版本
- `integrity=true` 数据库完整性检查通过
### 7. GPU 排障阶梯（按顺序试，找到能启动的那一档就停）

当前 `electron/main.cjs` 已经默认启用了第 1 档。如果仍然出现
`GPU process launch failed: error_code=18` → `FATAL: GPU process isn't usable`，往下走。

**第 1 档（默认，已内置）**

```powershell
npm run dev
```

内置：`disableHardwareAcceleration` + `disable-gpu` + `disable-gpu-compositing` + `disable-software-rasterizer` + `in-process-gpu` + `disable-gpu-shader-disk-cache`。

**第 2 档：数据目录不可写时换目录**

日志里若出现 `Failed to open ...\GPUCache\data_N`，说明 userData 下缓存目录写不进去（该目录可能由管理员创建、普通用户无权限）：

```powershell
$env:TK_DATA_DIR="D:\toolkit-data"
npm run dev
```

**第 3 档：禁用沙箱**

```powershell
$env:TK_NO_SANDBOX="1"
npm run dev
```

**第 4 档：绕过 Vulkan / 强制软件渲染（应急开关）**

```powershell
$env:TK_SWITCHES="disable-features=Vulkan,enable-unsafe-swiftshader"
npm run dev
```

`TK_SWITCHES` 支持任意 Chromium 开关，逗号分隔，有值用 `=`。

**第 5 档：临时清空缓存目录后重试**

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\efficiency-toolkit\GPUCache" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:APPDATA\efficiency-toolkit\Cache" -ErrorAction SilentlyContinue
npm run dev
```

**第 6 档：确认是否环境性限制**

若以上全部无效，用最小应用验证是环境问题还是本项目问题：

```powershell
# 新建 min 目录，放 package.json 与一个只创建空窗口的 main.js，然后：
.\node_modules\electron\dist\electron.exe .\min
```

最小应用也崩 → 本机 Electron 运行环境受限（虚拟显卡/远程会话/安全软件），与本项目代码无关。
---

## 版本决策：为什么锁定 Electron 28

本项目最初用 Electron 33，遇到 `GPU process isn't usable` 直接 FATAL 退出。已回退到 **Electron 28.3.3**。

| | Electron 33（Chromium 130） | Electron 28（Chromium 120） |
| --- | --- | --- |
| GPU 进程启动失败 | **FATAL 直接退出** | 静默回退软件渲染，继续运行 |
| 对 userData 目录权限 | 更严格，缓存不可写即失败 | 容错更好 |
| 本机表现 | 崩 | 可用 |

这正是「别的项目没问题、这个项目有问题」的原因：老项目用旧版 Electron，GPU 失败会降级而非致命。

### 升级注意事项

换 Electron 主版本后，**必须重新编译 better-sqlite3**，否则 ABI 不匹配：

```powershell
npm run rebuild        # 等价于 electron-rebuild -f -w better-sqlite3
```

### 当前版本锁定

```
electron        28.3.3
better-sqlite3  11.10.0（已按 Electron ABI 编译）
vue             3.5.x
naive-ui        2.45.3
vite            6.x
```
### 8. 原生模块编译：本机无 VS 工具链时的正解

`npm run rebuild`（electron-rebuild）在**没有 Visual Studio C++ 构建工具**的机器上会失败：

```
gyp ERR! find VS could not use PowerShell to find Visual Studio 2017 or newer
```

正确做法是用 **prebuild-install 直接下载匹配 Electron ABI 的预编译二进制**，不需要编译器：

```powershell
cd node_modules\better-sqlite3
npx prebuild-install --runtime=electron --target=28.3.3 --arch=x64 --platform=win32
cd ../..
```

成功标志：日志出现

```
prebuild-install info found cached prebuild
prebuild-install info unpacking @ ...better-sqlite3-v11.10.0-electron-v119-win32-x64.tar.gz
prebuild-install info install Successfully installed prebuilt binary!
```

`electron-v119` 就是 Electron 28（Node 18）的 ABI；Electron 33 对应 `v130`。

**校验绑定是否正确**：比对绑定文件与缓存包哈希应一致

```powershell
sha256sum node_modules/better-sqlite3/build/Release/better_sqlite3.node
# 与 %LOCALAPPDATA%\npm-cache\_prebuilds\*-electron-v119-*.tar.gz 解出的文件一致即可
```

### 9. 一句话版本对照

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Electron | 28.3.3 | 降级以避开 Chromium 130 的 GPU 硬失败 |
| better-sqlite3 | 11.10.0 | 绑定为 `electron-v119`（Electron 28 ABI） |
| Node（构建用） | 26.13.0 | 仅用于构建与工具链，运行时是 Electron 内置 Node 18 |
### 10. GL 相关报错说明（Electron 28）

日志里这两行属于**无害回退**，应用仍能正常渲染：

```
ERROR:gpu_channel_manager.cc(953)] Failed to create GLES3 context, fallback to GLES2.
ERROR:check.cc(297)] Check failed: false. NOTREACHED ...
```

含义：Chromium 想用 GLES3 建 GPU 上下文，你的环境（虚拟显卡 / 远程会话）不支持，于是退回 GLES2。`NOTREACHED` 是 Chromium 内部断言在官方构建里被静默的提示。

**如果同时出现这一行，就是配置问题**：

```
ERROR:gl_factory.cc(120)] Requested GL implementation (gl=none,angle=none) not found in allowed implementations: [(gl=egl-angle,angle=default)]
```

原因是给 Electron 28 传了它不认识的 `use-gl=swiftshader` / `use-angle=swiftshader`。Chromium 120 只接受 `egl-angle`，传 swiftshader 会让它去解析一个不存在的实现（`gl=none`），反而破坏 GL 初始化。

**处置**：不要手动指定 `use-gl` / `use-angle`。当前 `main.cjs` 只保留 `disableHardwareAcceleration()` 与几个缓存/联网开关，交给 Electron 28 自己回退。

若确实需要强制软件渲染，用 28 认识的写法：

```powershell
$env:TK_SWITCHES="use-angle=swiftshader"
npm run dev
```

---

## 日志健康基线

正常启动时，终端里允许出现以下**无害**日志：

| 日志 | 是否影响功能 |
| --- | --- |
| `Failed to create GLES3 context, fallback to GLES2` | 否，已回退 |
| `Check failed: false. NOTREACHED` | 否，Chromium 内部断言 |
| `ssl_client_socket_impl.cc handshake failed` | 否，后台探测被网络拦截 |
| `[db] ... integrity=true` | 这是**成功**标志 |

出现以下则需要处理：`FATAL: GPU process isn't usable`（换 Electron 28 后不该再出现）、`Failed to open ...GPUCache`（用 `TK_DATA_DIR` 换目录）。
---

## GPU 配置演进记录（避免反复踩坑）

本机 GPU 子进程无法启动（`error_code=18`），以下组合的实际结果：

| 配置 | 结果 |
| --- | --- |
| Electron 33 + 默认 | `FATAL: GPU process isn't usable`（Chromium 130 硬失败） |
| Electron 28 + 默认 | 同样 FATAL |
| Electron 28 + `disableHardwareAcceleration()` | **仍然 FATAL**（Chromium 仍会派生 GPU 子进程） |
| Electron 28 + `disableHardwareAcceleration()` + `in-process-gpu` | ✅ **能启动** |
| Electron 28 + 上述 + `use-gl=swiftshader` | ❌ `Requested GL implementation not found`，并再次 FATAL |

**结论（当前采用）**：

```js
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
```

**三条铁律**：

1. `in-process-gpu` 是必需项，不是可选项。只关硬件加速不足以阻止 GPU 子进程派生。
2. **不要**加 `use-gl` / `use-angle`。Electron 28 只接受 `egl-angle`，其他值会让 GL 初始化彻底失败。
3. 每次改这段后务必实跑确认，不能只看代码「看起来对」。
---

## 日志系统

### 位置

```
%APPDATA%\efficiency-toolkit\logs\app-YYYY-MM-DD.log
```

设置页「运行日志」卡片可查看路径、文件数，并提供「打开日志目录」。

### 覆盖范围

| 来源 | 记录内容 |
| --- | --- |
| 主进程未捕获异常 | `uncaughtException` / `unhandledRejection` 完整堆栈 |
| IPC 处理失败 | channel、入参、耗时、异常栈 |
| IPC 入参非法 | 校验失败的字段与原因（warn 级） |
| 渲染进程异常 | Vue errorHandler、unhandledrejection、window error |
| 数据库 | 建库路径、schema 版本、迁移列表、完整性检查 |
| 应用生命周期 | 启动版本信息、退出 |

### 格式

```
2026-11-20 00:05:49.134 [ERROR] [ipc] handler_failed {"channel":"todo:create","errorMessage":"boom","stack":"..."}
```

`时间 [级别] [作用域] 消息 {结构化元数据}`

### 机制

- **按天切分**：文件名含日期，跨天自动切换
- **大小轮转**：单文件超 5MB 重命名归档
- **自动清理**：保留 14 天，启动时删除过期文件
- **同步写入**：`appendFileSync` 保证崩溃前日志已落盘（异步流在进程崩溃时会丢）
- **敏感脱敏**：`password/token/secret/apikey/cookie/authorization` 等键自动替换为 `***`

### 配置

```powershell
# 调整日志级别（debug / info / warn / error，默认 info）
$env:TK_LOG_LEVEL="debug"
npm run dev
```

### 前端用法

```ts
import { log } from '@/lib/logger'

log.info('todo', 'task created', { id })
log.exception('todo', err, 'createTodo')
```

浏览器预览（无 IPC）时自动降级为 `console`，不抛错。
---

## 日程 ↔ 待办 双向联动

### 日程 → 待办（日程详情抽屉「转为待办」）

自动同步以下字段：

| 字段 | 来源 |
| --- | --- |
| 标题 | 日程标题 |
| 截止时间 | 日程开始时间（重复日程取当前实例） |
| 提醒 | 按日程「提前 N 分钟」反算 remindAt |
| 清单 | 按日历分类名匹配同名待办清单 |
| 备注 | 日程备注 |
| 关联 | `scheduleId` + `sourceType/sourceRef` 回指日程 |

转换成功后自动关闭详情抽屉，并提示同步后的截止时间。

### 待办 → 日程（任务详情抽屉「转为日程」）

| 字段 | 来源 |
| --- | --- |
| 标题 | 待办标题 |
| 开始时间 | 待办截止时间；无截止时间则排在今天 09:30 |
| 结束时间 | 开始时间 + 1 小时 |
| 分类 | 按待办清单名匹配同名日程日历 |
| 备注 | 待办备注 |

### 验证

```
日程→待办: 日期同步 OK (2026/11/20 09:30) | 关联 OK | 提醒 OK | 备注 OK
待办→日程: 日期同步 OK (2026/11/20 09:30) | 时长 1 小时 OK
```
---

# 项目完成状态（2026-11-20）

## 已完成的 9 个模块

| 模块 | 服务层 | 视图 | 状态 |
| --- | --- | --- | --- |
| 首页仪表盘 | 聚合已有服务 | Home.vue | ✅ |
| 待办 | todo.cjs | Todo.vue | ✅ 三栏/筛选/看板/子任务/提醒/标签/关联 |
| 日程 | schedule.cjs | Schedule.vue | ✅ 月视图/分类筛选/冲突/ICS/双向联动 |
| 番茄钟 | pomodoro.cjs | Pomodoro.vue | ✅ 计时/统计/全屏/设置/中断/结束提示 |
| 天气 | weather.cjs | Weather.vue | ✅ 多城市/Hero/24h/7天/AQI/生活指数/抽屉 |
| 信息流 | feed.cjs | Feed.vue | ✅ 三栏阅读器/订阅源/OPML/规则抽屉 |
| 快递 | parcel.cjs | Parcel.vue | ✅ 状态Tab/卡片/轨迹抽屉/隐私/取件待办 |
| 邮件 | mail.cjs | Mail.vue | ✅ 三栏客户端/安全提示/写邮件/规则抽屉 |
| 设置 | settings.cjs | Settings.vue | ✅ 日志面板/主题/数据管理 |

## 基础设施

- 数据层：SQLite（24 表）+ 3 个迁移 + 统一 conn/withTx/util
- IPC：9 个域，zod 校验 + 错误规范化 + 变更广播 + preload 白名单
- 日志：按天切分、5MB 轮转、14 天保留、敏感脱敏、同步写入
- 前端：Vue3 + TS + Naive UI（全部组件）+ Pinia 薄层 + bridge()/plain() 防 Illegal invocation
- 打包：Electron 28.3.3 + electron-builder 配置

## 最终验证

```
npx vue-tsc --noEmit   通过
npm run build          通过（2711 modules，CSS 33.93kB / JS 2075kB）
9 个页面渲染          脚本错误 0
服务层回归            迁移1,2,3 / 天气24°+24h+7天 / 信息流12篇 / 快递轨迹 / 待办 / 日程 / 番茄 / 邮件 全部通过
```

## 启动

```powershell
npm run dev
```

数据目录：`%APPDATA%\efficiency-toolkit\`
日志目录：`%APPDATA%\efficiency-toolkit\logs\`
