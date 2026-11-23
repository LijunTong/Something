-- 009_feed_group_default.sql · 信息流分类：颜色 + 默认分类
-- 默认分类可以改名但不可删除；删除其它分类时，其下订阅（及文章）迁到默认分类。
ALTER TABLE feed_group ADD COLUMN color TEXT NOT NULL DEFAULT '#0f766e';
ALTER TABLE feed_group ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- 新库一个分类都没有：补一个默认分类；老库至少已有一个分类，走下面的回填
INSERT INTO feed_group (id, name, color, is_default)
SELECT 'grp_default', '默认分类', '#0f766e', 1
WHERE NOT EXISTS (SELECT 1 FROM feed_group);

-- 保证恰有一个默认分类：取名字最前的一条，规则与 007 的待办清单一致
UPDATE feed_group SET is_default = 1
  WHERE id = (SELECT id FROM feed_group ORDER BY name ASC, id ASC LIMIT 1);

-- 未分组 / 指向已不存在分类的订阅统一落到默认分类，「我的分类」里才都能看到
UPDATE feed_source SET group_id = (SELECT id FROM feed_group WHERE is_default = 1 LIMIT 1)
  WHERE group_id IS NULL OR group_id NOT IN (SELECT id FROM feed_group);
