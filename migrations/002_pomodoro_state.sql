-- 002_pomodoro_state.sql · 补充计时绝对时间戳与计划时长
ALTER TABLE pomodoro_state ADD COLUMN ends_at INTEGER;
ALTER TABLE pomodoro_state ADD COLUMN planned_sec INTEGER;
