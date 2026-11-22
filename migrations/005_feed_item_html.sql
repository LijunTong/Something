-- 信息流正文 HTML：保留 RSS/Atom 原始排版，与纯文本 content 并存
ALTER TABLE feed_item ADD COLUMN content_html TEXT;
