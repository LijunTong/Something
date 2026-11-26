-- 014：删除墓碑 —— 记下用户删掉的条目，避免下次同步/刷新又把它插回来
-- 信息流：按 (source_id, guid) 记；邮件：按 (account_id, msg_id) 记。
-- 只存标识与时间，不存正文；删订阅源/邮箱账户时一并清理。

CREATE TABLE IF NOT EXISTS feed_deleted (
  source_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, guid)
);

CREATE TABLE IF NOT EXISTS mail_deleted (
  account_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, msg_id)
);
