-- 004_weather_city_geo.sql · 和风天气定位信息（GeoAPI 查询结果）
-- LocationID 用于 v7 接口的 location 参数；经纬度用于 v1/预警接口。
ALTER TABLE weather_city ADD COLUMN qweather_id TEXT;
ALTER TABLE weather_city ADD COLUMN lat REAL;
ALTER TABLE weather_city ADD COLUMN lon REAL;
ALTER TABLE weather_city ADD COLUMN adm1 TEXT;
ALTER TABLE weather_city ADD COLUMN adm2 TEXT;
ALTER TABLE weather_city ADD COLUMN updated_at INTEGER;
