-- 010：默认项命名对齐 + 历史「无清单 / 无分组」数据归位

-- 1) 日程默认分组改名为「默认分组」：只改仍是旧种子名的默认项，用户改过名的不动
UPDATE schedule_calendar SET name = '默认分组' WHERE is_default = 1 AND name = '默认';

-- 2) 历史待办没有清单时归到默认清单；迁移先于 seed 执行，用 EXISTS 防新库空表
UPDATE todo SET list_id = (SELECT id FROM todo_list WHERE is_default = 1 LIMIT 1)
WHERE list_id IS NULL AND EXISTS (SELECT 1 FROM todo_list WHERE is_default = 1);

-- 3) 历史日程没有分组时归到默认分组
UPDATE schedule SET calendar_id = (SELECT id FROM schedule_calendar WHERE is_default = 1 LIMIT 1)
WHERE calendar_id IS NULL AND EXISTS (SELECT 1 FROM schedule_calendar WHERE is_default = 1);
