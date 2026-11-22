-- 早期版本点开文章会抓原网页抽正文，整页 HTML 里带导航、相关阅读等站点外框。
-- 阅读器只显示 RSS 自带正文，这里清掉那批脏数据；下次刷新会按 RSS 重新写入合格 HTML。
UPDATE feed_item SET content_html = NULL;
