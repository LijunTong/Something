-- 013：信息流全文补全 —— 记录每篇文章抓原文的结果，避免重复抓取
-- full_fetch_at：最近一次抓原文的时间（毫秒）；full_fetch_ok：是否已抓到并写入全文
ALTER TABLE feed_item ADD COLUMN full_fetch_at INTEGER;
ALTER TABLE feed_item ADD COLUMN full_fetch_ok INTEGER NOT NULL DEFAULT 0;
