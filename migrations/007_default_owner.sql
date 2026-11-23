-- 007_default_owner.sql · 清单 / 分组增加「默认」标记
-- 默认项可以改名但不可删除；删除其它项时，其下记录在 services 内迁移到默认项。
ALTER TABLE todo_list ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedule_calendar ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- 已有数据：把排序最前的一条认作默认项，保证每张表恰有一个默认。
UPDATE todo_list SET is_default = 1
  WHERE id = (SELECT id FROM todo_list ORDER BY sort ASC, id ASC LIMIT 1);
UPDATE schedule_calendar SET is_default = 1
  WHERE id = (SELECT id FROM schedule_calendar ORDER BY sort ASC, id ASC LIMIT 1);
