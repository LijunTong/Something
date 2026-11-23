// 天气定时播报的档位判定：09:00 / 12:00 / 17:00 / 20:00，每档 1 小时补发窗口。
// 只做时间计算与事件 id，不读数据库、不依赖 electron，便于单独测试。
const HOUR = 3600000
const DEFAULT_SLOTS = [9, 12, 17, 20]
/** 每档的补发窗口：进程在档位后 1 小时内启动仍会播报一次 */
const WINDOW_MS = HOUR

/** 档位列表：默认 09/12/17/20；无头测试可用 TK_WEATHER_DIGEST_SLOTS=9,10 覆盖 */
function slots() {
  const raw = String(process.env.TK_WEATHER_DIGEST_SLOTS || '').trim()
  if (!raw) return DEFAULT_SLOTS.slice()
  const list = raw.split(',').map(function (x) { return Number(String(x).trim()) })
    .filter(function (h) { return Number.isInteger(h) && h >= 0 && h <= 23 })
  return list.length ? list : DEFAULT_SLOTS.slice()
}

function dayStart(t) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 当前落在哪一档的窗口里；不在任何窗口返回 null（各档间隔 3 小时，窗口不会重叠） */
function dueHour(t, list) {
  const base = dayStart(t)
  const arr = Array.isArray(list) && list.length ? list : slots()
  for (let i = 0; i < arr.length; i++) {
    const at = base + Number(arr[i]) * HOUR
    if (t >= at && t < at + WINDOW_MS) return Number(arr[i])
  }
  return null
}

/** 同一天同一档的事件 id：复用 notifyEmitted 去重，一天只播一次 */
function eventId(t, hour) {
  const d = new Date(t)
  const pad = function (n) { return (n < 10 ? '0' : '') + n }
  return 'weather:digest:' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ':' + hour
}

module.exports = {
  HOUR: HOUR, DEFAULT_SLOTS: DEFAULT_SLOTS, WINDOW_MS: WINDOW_MS,
  slots: slots, dueHour: dueHour, eventId: eventId
}
