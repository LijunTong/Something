-- 001_init.sql · 个人效率工具集初始 schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS todo_list (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT,
  sort INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);

CREATE TABLE IF NOT EXISTS todo (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT,
  list_id TEXT REFERENCES todo_list(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT '中', due_at INTEGER, remind_at INTEGER,
  status TEXT NOT NULL DEFAULT '未开始', done_at INTEGER, recur_rule TEXT,
  source_type TEXT, source_ref TEXT,
  focus_seconds INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_todo_status_due ON todo(status, due_at);
CREATE INDEX IF NOT EXISTS idx_todo_list ON todo(list_id);

CREATE TABLE IF NOT EXISTS todo_subtask (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL REFERENCES todo(id) ON DELETE CASCADE,
  title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_subtask_todo ON todo_subtask(todo_id);

CREATE TABLE IF NOT EXISTS schedule_calendar (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2563eb', visible INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS schedule (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0, place TEXT,
  calendar_id TEXT REFERENCES schedule_calendar(id) ON DELETE SET NULL,
  remind_min INTEGER NOT NULL DEFAULT 10, recur_rule TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT '确认',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_schedule_start ON schedule(start_at);

CREATE TABLE IF NOT EXISTS schedule_exception (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  excluded_date TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_schexc_schedule ON schedule_exception(schedule_id);

CREATE TABLE IF NOT EXISTS pomodoro_session (
  id TEXT PRIMARY KEY, task_type TEXT, task_id TEXT, tag TEXT,
  planned_min INTEGER NOT NULL, actual_min INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL, interrupt_reason TEXT);
CREATE INDEX IF NOT EXISTS idx_pomo_started ON pomodoro_session(started_at);

CREATE TABLE IF NOT EXISTS pomodoro_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL DEFAULT 'idle', remain_sec INTEGER NOT NULL DEFAULT 1500,
  round INTEGER NOT NULL DEFAULT 1, task_id TEXT, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS weather_city (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  is_home INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS weather_cache (
  city_id TEXT NOT NULL REFERENCES weather_city(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (city_id, kind));

CREATE TABLE IF NOT EXISTS feed_group (id TEXT PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS feed_source (
  id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT,
  group_id TEXT REFERENCES feed_group(id) ON DELETE SET NULL,
  interval_min INTEGER NOT NULL DEFAULT 60, enabled INTEGER NOT NULL DEFAULT 1,
  last_fetch_at INTEGER, etag TEXT);

CREATE TABLE IF NOT EXISTS feed_item (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES feed_source(id) ON DELETE CASCADE,
  guid TEXT NOT NULL, title TEXT NOT NULL, link TEXT, author TEXT,
  summary TEXT, content TEXT, published_at INTEGER,
  read INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0,
  read_later INTEGER NOT NULL DEFAULT 0, content_hash TEXT,
  UNIQUE (source_id, guid));
CREATE INDEX IF NOT EXISTS idx_feeditem_source_pub ON feed_item(source_id, published_at);

CREATE TABLE IF NOT EXISTS parcel (
  id TEXT PRIMARY KEY, company TEXT NOT NULL, tracking_no TEXT NOT NULL UNIQUE,
  alias TEXT, note TEXT, status TEXT NOT NULL DEFAULT '在途',
  pickup_code TEXT, station TEXT, eta_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0, privacy_masked INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_parcel_status ON parcel(status);

CREATE TABLE IF NOT EXISTS parcel_track (
  id TEXT PRIMARY KEY,
  parcel_id TEXT NOT NULL REFERENCES parcel(id) ON DELETE CASCADE,
  node_time INTEGER NOT NULL, description TEXT NOT NULL, location TEXT);
CREATE INDEX IF NOT EXISTS idx_track_parcel ON parcel_track(parcel_id, node_time);

CREATE TABLE IF NOT EXISTS mail_account (
  id TEXT PRIMARY KEY, alias TEXT NOT NULL, email TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'imap', imap_host TEXT, imap_port INTEGER,
  smtp_host TEXT, smtp_port INTEGER, username TEXT, secret_enc TEXT,
  sync_days INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at INTEGER);

CREATE TABLE IF NOT EXISTS mail_folder (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'custom',
  unread_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_folder_account ON mail_folder(account_id);

CREATE TABLE IF NOT EXISTS mail (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES mail_folder(id) ON DELETE SET NULL,
  uid TEXT, msg_id TEXT, from_name TEXT, from_addr TEXT,
  to_addrs TEXT, cc_addrs TEXT, subject TEXT, snippet TEXT,
  body_html TEXT, body_text TEXT, has_attach INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER, read INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0, important INTEGER NOT NULL DEFAULT 0, labels TEXT);
CREATE INDEX IF NOT EXISTS idx_mail_account_folder_sent ON mail(account_id, folder_id, sent_at);

CREATE TABLE IF NOT EXISTS mail_rule (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  conditions TEXT NOT NULL, actions TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS mail_attachment (
  id TEXT PRIMARY KEY,
  mail_id TEXT NOT NULL REFERENCES mail(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, local_path TEXT);
CREATE INDEX IF NOT EXISTS idx_attach_mail ON mail_attachment(mail_id);

CREATE TABLE IF NOT EXISTS notification (
  id TEXT PRIMARY KEY, module TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'normal', title TEXT NOT NULL, body TEXT,
  created_at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_notify_read ON notification(read, created_at);

CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
  detail TEXT, created_at INTEGER NOT NULL);
