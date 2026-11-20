# AGENTS.md · 效率工具集

> 本文件是本项目的硬性开发约定。任何 AI 代理或开发者改动本项目前必须先读，且不得违反。
> 与通用偏好冲突时，以本文件为准。

---

## 一、组件：能使用 Naive UI 就必须用 Naive UI

**这是硬性规定，不是建议。**

### 1.1 强制使用

凡是 Naive UI 有对应组件的能力，**一律使用 Naive UI，禁止手写等价实现**：

| 场景 | 必须使用 | 禁止手写 |
| --- | --- | --- |
| 弹窗 | `n-modal` | `.modal-mask` + `.modal` 自绘弹层 |
| 抽屉 | `n-drawer` + `n-drawer-content` | `.drawer` + `.drawer-mask` 自绘 |
| 按钮 | `n-button` / `n-button-group` | `.primary-btn` / `.ghost-btn` 自绘按钮 |
| 输入框 | `n-input` | 裸 `<input>` + 自绘边框 |
| 下拉选择 | `n-select` | 原生 `<select>` |
| 开关 | `n-switch` | 自绘 `.switch` + `::after` |
| 复选框 | `n-checkbox` | 裸 `<input type=checkbox>` + 自绘勾选态 |
| 单选 | `n-radio` / `n-radio-group` | 裸 radio |
| 日期时间选择 | `n-date-picker` | 文本输入框收时间字符串 |
| 表格 | `n-data-table` | 手写 `<table>` |
| 标签 | `n-tag` | 自绘 `.tag` |
| 空状态 | `n-empty` | 自绘插画 + 文案 |
| 加载态 | `n-spin` / `n-skeleton` | 手写骨架屏 |
| 进度环/条 | `n-progress` | CSS 画圆环 |
| 表单与校验 | `n-form` + `n-form-item` | 手写校验逻辑与错误文案 |
| 消息提示 | `useMessage()` | 自写 toast 函数 |
| 确认框 | `useDialog()` | 自写 confirm 弹层 |
| 通知 | `useNotification()` | 自写浮层 |
| 标签页 | `n-tabs` | 自绘 tab 条 |
| 分页 | `n-pagination` | 手写页码 |
| 树形 | `n-tree` | 手写递归列表 |
| 折叠面板 | `n-collapse` | 手写展开收起 |
| 描述列表 | `n-descriptions` | 手写 label/value 行 |
| 上传 | `n-upload` | 裸 `<input type=file>` + 自绘 |
| 日期格式化 | `n-time` / dayjs | 手写补零拼接 |

### 1.1.1 组件形态不匹配时怎么办（重要）

「有对应组件」不等于「组件形态合适」。当出现以下情况时，属于**形态不匹配**，需要按下面的顺序降级处理，不能硬塞：

- 组件被压缩到其设计宽度以下，导致内容重叠、截断、换行错乱；
- 组件自带的交互语义与场景冲突（例如整月大日历要放 232px 侧栏、`n-data-table` 要放进 300px 卡片）；
- 组件的 DOM 结构需要大量 `:deep` 才能改名次（这已违反 2.4）。

**处理顺序（必须逐级判断，不能跳级）**：

1. **先调主题/尺寸**：看 `themeOverrides` 是否有字号、行高、padding 变量能压到目标尺寸；能压住就用组件。
2. **再用插槽定制**：组件提供 `header` / `default` / `cell` 等插槽时，用插槽换成紧凑内容，外壳仍用组件。
3. **再换同类组件**：同一组件库内换形态更合适的组件（如 `n-date-picker type="date"` 代替 `n-calendar` 做选日期）。
4. **最后才自写**：以上都不行，自写成紧凑形态，并在代码注释写明：用了哪个组件、为什么压不住、做了哪三级尝试。

**判定必须留证据**：在提交说明或注释里写清「试过什么、卡在哪里」，不能只说「不合适」。

### 1.2 允许保留自写的部分

只有当 Naive UI **没有**对应组件，或出于产品视觉识别必须自定义时，才允许自写，且必须满足：

1. **产品独占型视觉**：首页 8 张卡片的内部布局、天气 Hero 大数字、番茄圆环外层容器、日程周视图时间网格与事件块定位、信息流阅读器正文排版。
2. **布局容器**：`div` 网格、flex 排布、栅格定位等纯布局结构不受限制。
3. **图标**：保留 `src/components/Icons.vue` 的自写 SVG sprite（与原型线性风格一致），统一用 `<AppIcon>` 或直接 `<svg><use href="#i-xxx"/></svg>`。

自写的部分必须在代码注释里写明理由（哪个组件缺失 / 哪个视觉识别需要）。

---

## 二、样式：只写布局，不写外观

**这是硬性规定。**

### 2.1 允许写的 CSS

只允许布局相关属性：

- 布局：`display`、`grid-template-*`、`flex`、`gap`、`align-items`、`justify-content`、`order`、`position`、`top/right/bottom/left`、`z-index`、`inset`
- 尺寸：`width`、`min-width`、`max-width`、`height`、`min-height`、`max-height`、`aspect-ratio`
- 间距：`margin`、`padding`（仅用于纯布局留白，不用于给组件描边）
- 溢出：`overflow`、`overflow-x/y`

### 2.2 禁止写的 CSS

以下外观属性**一律不得出现在组件的自定义样式里**，必须通过 Naive UI 主题变量统一控制：

- 颜色：`color`、`background`、`background-color`、`border-color`、`outline-color`、`fill`、`stroke`
- 边框：`border`、`border-width`、`border-style`、`border-radius`、`box-shadow`、`outline`
- 字体：`font-size`、`font-weight`、`font-family`、`line-height`、`letter-spacing`、`text-decoration`
- 动效：`transition`、`animation`（Naive UI 组件自带，不重复定义）

### 2.3 外观必须走主题变量

所有颜色、圆角、字号、阴影**只能**定义在 `src/theme/naive.ts` 的 `themeOverrides` / `darkOverrides` 里，通过 `<n-config-provider :theme-overrides>` 全局生效。

要改外观 → **改主题变量文件**，不要改组件 CSS。

### 2.4 禁止用 :deep 打补丁

**禁止**用 `:deep(.n-xxx)` 覆盖 Naive UI 组件内部样式。

遇到必须调整的情况：
1. 先查 Naive UI 是否有对应的主题变量（`common.*`、`Component.*`）；
2. 有 → 加到 `src/theme/naive.ts`；
3. 没有 → 说明理由，与需求方确认后才能破例，并在注释写明原因。

---

## 三、样式文件组织

```
src/styles/
  tokens.css      设计令牌（取自原型），仅作文档参考，运行时以 theme/naive.ts 为准
  index.css       全局重置 + 仅布局相关的公共类
  schedule.css    日程页独占的布局样式（周视图网格等）
  ...             其余按页面拆分，只放布局
```

规则：
- 页面级 CSS 只放该页**布局**，不放外观。
- 公共外观统一在 `theme/naive.ts`，不在多处重复定义。
- 不再从 `design/toolkit/*.css` 直接复制外观样式到 `src/`；原型 CSS 只作视觉参照与令牌取值来源。

---

## 四、技术栈与架构约束

| 层 | 约束 |
| --- | --- |
| 桌面容器 | Electron，`contextIsolation: true`，渲染进程无 Node 权限 |
| UI | Vue 3 组合式 API + `<script setup lang="ts">` |
| 组件库 | Naive UI（2.45.x），按需引入，禁止整包 `import * as naive` |
| 状态 | Pinia 薄层，只放 UI 态与视图缓存；**业务数据不进 Pinia 常驻** |
| 数据库 | SQLite（better-sqlite3），**只在主进程访问** |
| 通信 | 渲染进程只能通过 `window.api.<domain>.<method>()`，禁止通用 `invoke(channel)` 透传 |
| 校验 | 所有 IPC 入参在主进程用 zod 校验，非法入参返回结构化错误 |
| 语言 | TypeScript，禁止新增 `.js` 源文件（Electron 主进程 CJS 除外） |

### 4.1 IPC 与数据访问铁律

1. **渲染进程不得直接读写数据库**，哪怕技术上可行。
2. 新增能力必须走：`preload 白名单` → `ipc/registry` → `services/*` → `db`。
3. 每个 domain 一个 service 文件，SQL 只写在 service 里，视图组件里不出现 SQL。
4. 写操作统一包在 `withTx()` 事务内。
5. 嵌套调用时用内部 `xxxRaw()` 避免重复开事务。

### 4.2 无 IPC 环境（浏览器预览）

所有 `call()` 必须提供 fallback，保证在没有 Electron 的浏览器里页面仍可渲染：

```ts
const rows = await call(() => window.api.todo.list({}), [] as TodoRow[])
```

禁止让 `window.api` 为 `undefined` 时直接白屏或抛错。

---

## 五、视觉基线

- 视觉标准以 `design/toolkit/*.html` + `*.css` 为准，布局结构、信息密度、元素顺序必须对齐原型。
- 令牌取值：画布 `#f5f7fa`、卡片 `#ffffff`、边框 `#e5e7eb`、主色 `#0f766e`、强调橙 `#c2410c`、卡片圆角 12px、控件圆角 8px、正文 13px。
- 蓝绿表示正常/本地/进行，橙色只表示提醒、待取件、异常。
- 所有图标为线性 SVG。

---

## 六、验证要求

每次改动完成前必须执行：

```
npx vue-tsc --noEmit    # 类型检查通过
npm run build           # 构建通过
```

涉及页面的改动，还要在设计工作台核对渲染无脚本错误、对比度达标、布局与原型一致。

未验证不得声称完成。

---

## 七、反面清单（曾犯过，禁止重犯）

1. ❌ 用自写 `.modal-mask` + `.modal` 做弹窗 —— 应用 `n-modal`。
2. ❌ 用自写 `.drawer` 做抽屉 —— 应用 `n-drawer`。
3. ❌ 用原生 `<select>` 做下拉 —— 应用 `n-select`。
4. ❌ 绕开原型 CSS 另写一套布局，导致结构与原型不一致 —— 必须复用原型布局结构。
5. ❌ 在组件 CSS 里写 `color` / `background` / `border-radius` —— 必须走主题变量。
6. ❌ 用 `:deep(.n-xxx)` 覆盖组件内部样式。
7. ❌ 单次写入超大文件导致内容被截断 —— 超过约 8KB 的内容分段追加写入，写完核对行数与末尾闭合标签。
8. ❌ 未经类型检查与构建就声称功能完成。