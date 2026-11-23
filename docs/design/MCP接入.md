# MCP 接入（项目计划写入）

## 目标

让 Agent 把某个项目的计划直接写进「几件事」：项目成为一个清单，计划条目成为待办，阶段/拆解成为子任务。不新建页面，不引入云端，不改现有待办的数据语义。

## 形态

- 应用内本地 HTTP 服务（MCP Streamable HTTP），只监听 `127.0.0.1`，默认端口 `3927`。
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

关闭开关立即停止监听；应用退出时也会停止。设置项 `mcp.enabled` 默认 `false`，即默认不监听端口。

## 涉及文件

- `electron/mcp/server.cjs`：HTTP 服务、鉴权、JSON-RPC 分发。
- `electron/mcp/tools.cjs`：工具 schema（zod → JSON Schema）与调度。
- `electron/services/project.cjs`：计划写入/读取/更新、项目解析与事务。
- `electron/services/settings.cjs`：`mcp` 默认值、`mcpToken` 存取与轮换。
- `migrations/012_project_plan.sql`：`project_plan` 表、`todo_subtask.source_ref`。
- `src/components/settings/McpPanel.vue`：设置面板。
- `src/views/Todo.vue`：清单计划条。
