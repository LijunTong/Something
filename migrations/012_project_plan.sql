-- 012：Agent 计划接入 —— 每个项目对应一个清单，计划条目复用待办 + 子任务

-- project_plan 只存「清单 ↔ 项目」的绑定与计划元数据；计划正文在 todo / todo_subtask 里。
-- project_key 是 Agent 侧稳定标识：清单改名不影响后续幂等写入。
CREATE TABLE IF NOT EXISTS project_plan (
  id TEXT PRIMARY KEY,
  -- 一个清单只绑定一个项目；删除清单时绑定一并删除（生产数据本身由既有逻辑迁移）
  list_id TEXT NOT NULL UNIQUE REFERENCES todo_list(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL UNIQUE,
  repo_path TEXT,
  title TEXT,
  summary TEXT,
  version TEXT,
  -- revision 每次 project_plan_write 加 1，用于界面显示「第 N 次写入」
  revision INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'mcp',
  last_writer TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_plan_key ON project_plan(project_key);

-- 子任务也要能被 Agent 幂等定位：<itemKey>:<subtaskKey>
ALTER TABLE todo_subtask ADD COLUMN source_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_subtask_source ON todo_subtask(todo_id, source_ref);
