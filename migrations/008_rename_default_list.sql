-- 008_rename_default_list.sql · 默认待办清单改名为「默认清单」
-- 只动「仍是默认项、且名字仍是旧种子名『收件箱』」的那条：
-- 用户自己改过名的默认清单保持原样，非默认清单不受影响。
UPDATE todo_list SET name = '默认清单'
  WHERE is_default = 1 AND name = '收件箱';
