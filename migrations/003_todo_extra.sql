-- 003_todo_extra.sql · 待办补充标签与关联日程

-- 标签：JSON 数组字符串，如 ["工作","紧急"]；默认 NULL 表示无标签
ALTER TABLE todo ADD COLUMN labels TEXT;

-- 关联日程：存 schedule.id，删除日程时置空而不是删任务
ALTER TABLE todo ADD COLUMN schedule_id TEXT REFERENCES schedule(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_todo_schedule ON todo(schedule_id);
