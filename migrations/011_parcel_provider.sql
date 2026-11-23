-- 011：快递数据源接入 —— 记录快递公司编码、收件人手机号后四位与最近一次同步结果

-- 各家接口的快递公司编码不同，统一在刷新时按当前数据源换算后缓存；手动指定的公司优先
ALTER TABLE parcel ADD COLUMN courier_code TEXT;
ALTER TABLE parcel ADD COLUMN phone_tail TEXT;
-- provider：最近一次成功查询用的数据源；provider_state：接口原始状态码（排障用）
ALTER TABLE parcel ADD COLUMN provider TEXT;
ALTER TABLE parcel ADD COLUMN provider_state TEXT;
ALTER TABLE parcel ADD COLUMN last_sync_at INTEGER;
-- last_error：最近一次失败的中文原因，刷新成功即清空；界面直接在卡片上提示
ALTER TABLE parcel ADD COLUMN last_error TEXT;

-- 轨迹去重靠 (parcel_id, node_time, description) 判重；不建唯一索引，避免历史重复数据阻断迁移
CREATE INDEX IF NOT EXISTS idx_parcel_track_dedupe ON parcel_track (parcel_id, node_time, description);
