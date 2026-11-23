# MCP 接入（项目计划写入）

## 目标

让 Agent 把某个项目的计划直接写进「几件事」：项目成为一个清单，计划条目成为待办，阶段/拆解成为子任务。不新建页面，不引入云端，不改现有待办的数据语义。

## 形态

- 应用内本地 HTTP 服务（MCP Streamable HTTP），只监听 `127.0.0.1`，默认端口：开发版 `3927`、安装版 `3928`（两套数据目录可同时运行，互不抢端口）。
- 单端点 `POST /mcp`，JSON-RPC 2.0；只实现 tools 能力，无 session、无 SSE。
- 鉴权：`Authorization: Bearer <token>`。令牌 32 字节随机 hex，存 `app_setting` 的 `mcpToken`（应用设置里默认掩码显示）。
- 协议版本：响应 `2025-06-18`，兼容客户端请求的 `2025-03-26` / `2024-11-05`。

## 数据映射

| 计划概念 | 落库位置 | 说明 |
| --- | --- | --- |
| 项目 | `todo_list` 一行 + `project_plan` 一行 | 清单名 = 项目名；一个清单最多绑定一个项目 |
| 计划条目 | `todo`，`source_type='plan'` | `source_ref='<projectKey>:<itemKey>'`，按 key 幂等更新 |
| 阶段/拆解 | `todo_subtask`，`source_ref='<itemKey>:<subKey>'` | 不含阶段层级，用 `labels` 表达阶段 |
| 计划元信息 | `project_plan` | title / summary / version / revision / repo_path / last_writer |

`revision` 每次写入 +1，待办页计划条据此显示「第 N 次写入」。

## 工具

### project_plan_write

入参：

```json
{
  "project": { "key": "something", "name": "Something", "description": "可选", "repoPath": "E:/repo" },
  "plan": {
    "title": "v1.1 计划",
    "summary": "可选，整体说明",
    "version": "1.1",
    "items": [
      {
        "key": "mcp-server",
        "title": "实现 MCP 服务",
        "status": "进行中",
        "priority": "高",
        "dueAt": "2026-12-01T18:00:00+08:00",
        "labels": ["阶段一"],
        "subtasks": [{ "key": "handler", "title": "路由与鉴权", "done": true }]
      }
    ]
  },
  "mode": "merge"
}
```

- `item.key` 必填且在同一次请求内唯一；建议由标题稳定派生（服务端在缺省时用 `k+sha1(title)[0:10]`）。
- `mode=merge`（默认）：只 upsert 本次提交的条目，不动其他条目。
- `mode=replace`：额外删除本次未提交的旧计划条目，但只删「用户未完成、未投入专注、未关联日程」的，避免误删用户成果。
- 未显式传入的 `status/done/note/priority/dueAt/labels` 不会覆盖库里已有值（保护用户手动勾选）；显式传 `null` 表示清空。

返回：

```json
{
  "project": { "key": "something", "name": "Something", "listId": "..." },
  "plan": { "revision": 3, "updatedAt": 1730000000000 },
  "mode": "merge",
  "counts": { "items": 12, "created": 2, "updated": 10, "removed": 0 }
}
```

### project_plan_read

按 `project.key` 或 `project.name` 读回项目、`revision`、进度统计与全部条目（含子任务 key 与 done）。写入前调用可避免重复建清单、看清用户改动。

### project_plan_item_update

只改一个条目：`status` / `done` / `note` / `priority` / `dueAt`，或带 `subtask`（有 `key` 改已有，无 `key` 或找不到时新建）。用于 Agent 推进单项进度。

### project_plan_list

列出本机所有已接入项目：`projectKey`、清单名、标题、`revision`、最近写入时间、完成进度。

## 错误约定

工具业务错误通过 `tools/call` 的 `isError: true` + 文本 `CODE: message` 返回，常见：

| CODE | 含义 |
| --- | --- |
| `INVALID_ARGS` | 入参不满足 schema（附字段路径） |
| `PROJECT_NOT_FOUND` | read/update 时项目不存在 |
| `PROJECT_KEY_MISMATCH` | 清单已绑定其他 projectKey |
| `LIST_IS_DEFAULT` | 不能把默认清单当项目 |
| `ITEM_NOT_FOUND` / `SUBTASK_NOT_FOUND` | 条目/子任务不存在 |
| `LIST_NAME_TAKEN` | 新建项目名与已有清单冲突 |

协议层错误用 JSON-RPC：`-32700` 解析失败、`-32600` 非法请求、`-32601` 方法不存在、`-32602` 参数缺失、`-32603` 工具执行异常。

## 安全边界

- 仅回环监听；校验 `Host` 与 `Origin` 只允许 `127.0.0.1` / `localhost`，挡住 DNS rebinding。
- 所有请求必须带 Bearer 令牌；比较用 `crypto.timingSafeEqual`，令牌每次请求现取，轮换后旧令牌立即失效。
- 请求体上限 1 MiB；`Content-Type` 必须是 `application/json`；响应 `Cache-Control: no-store`。
- 端口被占用时启动失败并保留 `lastError`，不自动漂移到其他端口，避免客户端配置静默失效。
- 日志只记工具名、成功与否、耗时与计数，不记计划正文与令牌。

## 开关与配置

设置 → Agent 接入：

1. 打开「启用 MCP 服务」；需要时改端口并点「应用」（会重启监听）。
2. 点「显示令牌」，复制。
3. 复制「客户端配置」，把令牌填入 `Authorization`。

```json
{
  "mcpServers": {
    "something-plan": {
      "type": "http",
      "url": "http://127.0.0.1:3927/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

### DeepSeek Harness

Harness 的 MCP 客户端是 `@deepseek-ai/dsh-mcp-client` 插件，配置不在 `mcpServers` JSON 里，而是写进 profile 的 `cordis.patch.yml`（Windows 默认 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）。追加一个 insert 条目：

```yaml
- insert:
    - id: something-plan
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: something-plan
        transport: streamable-http
        url: http://127.0.0.1:3927/mcp
        headers:
          Authorization: Bearer <TOKEN>
        reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 30 }
```

重启 Harness 生效；URL 端口按上一节的环境取值。条目 `id` 不能与已有条目重复，已有同名服务时直接改原条目即可。

关闭开关立即停止监听；应用退出时也会停止。设置项 `mcp.enabled` 默认 `false`，即默认不监听端口。

### 端口与环境隔离

| 场景 | 默认端口 | 说明 |
| --- | --- | --- |
| 开发（`npm run dev` / 未打包） | `3927` | 数据目录 `<repo>/.data` |
| 安装版 | `3928` | 数据目录 `%APPDATA%\Something`（或 exe 同级 `data/`） |
| `TK_MCP_PORT` 环境变量 | 以变量为准 | 合法范围 1024-65535；设置面板会显示来源并锁住端口输入 |
| 设置里手动改端口 | 以设置为准 | 点「应用」后立即重启监听 |

优先级：`TK_MCP_PORT` > 设置里的端口 > 按运行方式默认。设置项 `mcp.port` 默认 `null`（未手动指定）；只切开关时不会把默认端口写进设置。

令牌按数据目录各自生成（`app_setting.mcpToken`），开发版与安装版互不共用；同一个库内轮换令牌，所有客户端都要换新值。

## 涉及文件

- `electron/main.cjs`：MCP 生命周期、端口解析（环境变量/设置/默认）与 IPC 控制面。
- `electron/mcp/server.cjs`：HTTP 服务、鉴权、JSON-RPC 分发。
- `electron/mcp/tools.cjs`：工具 schema（zod → JSON Schema）与调度。
- `electron/services/project.cjs`：计划写入/读取/更新、项目解析与事务。
- `electron/services/settings.cjs`：`mcp` 默认值、`mcpToken` 存取与轮换。
- `migrations/012_project_plan.sql`：`project_plan` 表、`todo_subtask.source_ref`。
- `src/components/settings/McpPanel.vue`：设置面板。
- `src/views/Todo.vue`：清单计划条。
