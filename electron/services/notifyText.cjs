// 通知文案：一次事件的「标题 + 正文 + 强度」统一在这里生成。
// 规则：时间在前、事项在后（还有 5 分钟 · 吃饭）；正文只放时间/地点/取件码这类事实，
// 不复述「提前 N 分钟提醒」这类机制，也不编造动作。引擎与派生提醒共用同一套口径。
const HOUR = 3600000
const DAY = 86400000

function clock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function dayText(ts) {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 相对间隔的人类说法：不到 1 分钟 / 5 分钟 / 1 小时 20 分钟 / 2 天 */
function gapText(ms) {
  const abs = Math.abs(Number(ms) || 0)
  const min = Math.round(abs / 60000)
  if (min < 1) return '不到 1 分钟'
  if (min < 60) return min + ' 分钟'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h < 24) return m ? h + ' 小时 ' + m + ' 分钟' : h + ' 小时'
  const d = Math.round(h / 24)
  return d + ' 天'
}

function placeSuffix(place) {
  return place ? ' · ' + place : ''
}

/** 日程提醒：到点前报「还有多久」，到点后改口「到点了」 */
function scheduleReminder(s, t) {
  const startIn = Number(s.start_at) - t
  const where = placeSuffix(s.place)
  const at = clock(s.start_at)
  if (startIn > 60000) {
    return {
      level: startIn <= HOUR ? 'strong' : 'normal',
      title: '还有 ' + gapText(startIn) + ' · ' + s.title,
      body: at + ' 开始' + where
    }
  }
  return {
    level: 'strong',
    title: '到点了 · ' + s.title,
    body: at + ' 开始' + where
  }
}

/** 今日日程清单项（还没到提醒时间，只是让人知道今天有这个安排） */
function scheduleToday(s) {
  return {
    level: 'normal',
    title: '今天 · ' + s.title,
    body: clock(s.start_at) + ' 开始' + placeSuffix(s.place)
  }
}

/**
 * 待办提醒：有截止时间就按「离截止还有多久」说话。
 * 用户设的是「13:27 提醒我 13:32 的事」，说「还有不到 1 分钟」会让人以为截止快到了。
 */
function todoRemind(x, t) {
  const due = Number(x.due_at) || 0
  if (due) {
    const left = due - t
    if (left > 60000) {
      return {
        level: left <= 600000 ? 'strong' : 'normal',
        title: '还有 ' + gapText(left) + ' · ' + x.title,
        body: clock(due) + ' 前完成'
      }
    }
    return { level: 'strong', title: '到点了 · ' + x.title, body: '原定 ' + clock(due) + ' 完成' }
  }
  return { level: 'normal', title: '该做了 · ' + x.title, body: '提醒时间 ' + clock(x.remind_at) }
}

function todoDue(x, t) {
  const left = Number(x.due_at) - t
  if (left > 60000) {
    return {
      level: 'strong',
      title: '还有 ' + gapText(left) + '截止 · ' + x.title,
      body: clock(x.due_at) + ' 前完成'
    }
  }
  if (left > 0) {
    return { level: 'strong', title: '快截止了 · ' + x.title, body: clock(x.due_at) + ' 前完成' }
  }
  if (left > -60000) {
    // 刚好到点：说「到点了」，不要写「逾期不到 1 分钟」这种机器话
    return { level: 'strong', title: '到点了 · ' + x.title, body: '原定 ' + clock(x.due_at) + ' 完成' }
  }
  return {
    level: 'strong',
    title: '逾期 ' + gapText(left) + ' · ' + x.title,
    body: '原定 ' + clock(x.due_at) + ' 完成'
  }
}

const PARCEL_STATUS = {
  '派送中': { lead: '正在派送', level: 'normal' },
  '待取件': { lead: '到驿站了', level: 'strong' },
  '已签收': { lead: '已签收', level: 'normal' }
}

function parcel(p) {
  const meta = PARCEL_STATUS[p.status] || { lead: p.status, level: 'normal' }
  const bits = []
  if (p.status === '待取件') {
    if (p.pickup_code) bits.push('取件码 ' + p.pickup_code)
    bits.push(p.station || '驿站')
  } else if (p.status === '已签收') {
    bits.push('签收于 ' + dayText(Number(p.updated_at) || Date.now()))
    if (p.station) bits.push(p.station)
  } else {
    if (p.station) bits.push(p.station)
    if (Number(p.eta_at)) bits.push('预计 ' + dayText(Number(p.eta_at)) + ' 送达')
  }
  return {
    level: meta.level,
    title: meta.lead + ' · ' + p.company,
    body: bits.filter(Boolean).join(' · ') || null
  }
}

function mailDigest(m, t) {
  const count = Number(m.n) || 0
  const latest = Number(m.latest) || 0
  return {
    level: count >= 3 ? 'strong' : 'normal',
    title: count + ' 封重要邮件还没读',
    body: latest ? '最近一封 ' + (t - latest < DAY ? clock(latest) : dayText(latest)) : null
  }
}

function weatherAlert(a, at) {
  const title = String(a.title || a.type || '天气预警')
  const body = [String(a.level || '').trim(), String(a.text || '').trim()].filter(Boolean).join(' · ')
  return {
    level: 'strong',
    title: title,
    body: body ? body.slice(0, 120) : (at ? clock(at) + ' 发布' : null)
  }
}

/** 天气预警的短标签：给「还有 5 分钟」这类时间title留出读的空间 */
function pomodoroDone(plannedSec, restSec) {
  const focus = Math.max(1, Math.round(Number(plannedSec) / 60))
  const rest = Math.max(1, Math.round(Number(restSec) / 60))
  return {
    level: 'strong',
    title: '专注 ' + focus + ' 分钟完成',
    body: '休息 ' + rest + ' 分钟，起来走两步'
  }
}

function pomodoroBreakOver() {
  return { level: 'normal', title: '休息结束', body: '回到桌前，开始下一轮' }
}

/**
 * 天气播报：每天 09 / 12 / 17 / 20 点各一条，只读本地缓存里的 now/daily/aqi。
 * 标题固定「时段 · 天气」，正文只放当天真正有用的事实；字段缺失就跳过，不写 undefined。
 */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function tempText(v) {
  const n = num(v)
  return n == null ? '' : Math.round(n) + '℃'
}

function rangeText(lo, hi) {
  const a = num(lo)
  const b = num(hi)
  return a == null || b == null ? '' : Math.round(a) + '~' + Math.round(b) + '℃'
}

function bitsText(bits) {
  return bits.filter(Boolean).join(' · ')
}

function headline(label, bits) {
  const rest = bits.filter(Boolean).join(' ')
  return rest ? label + ' · ' + rest : label
}

function weatherDigest(snap, hour, t) {
  const s = snap || {}
  const cur = s.now || {}
  const daily = Array.isArray(s.daily) ? s.daily : []
  const today = daily[0] || {}
  const tomorrow = daily[1] || {}
  const aqi = s.aqi || {}
  const temp = tempText(cur.temp)
  const cond = String(cur.cond || today.textDay || '').trim()
  const pop = num(today.pop)
  const wind = [
    today.windDirDay,
    num(today.windScaleDay) == null ? '' : Math.round(num(today.windScaleDay)) + ' 级'
  ].filter(Boolean).join(' ')
  const h = Number(hour)

  if (h === 12) {
    const bits = [
      today.textDay ? '午后' + today.textDay : '',
      pop == null ? '' : '降水概率 ' + Math.round(pop) + '%',
      num(cur.feel) == null ? '' : '体感 ' + tempText(cur.feel),
      pop != null && pop >= 40 ? '记得带伞' : ''
    ]
    return { level: 'strong', title: headline('午间', [temp, cond]), body: bitsText(bits) || null }
  }

  if (h === 17) {
    const bits = [
      wind,
      aqi.level ? '空气质量' + String(aqi.level) : '',
      today.sunset ? '日落 ' + today.sunset : ''
    ]
    return { level: 'strong', title: headline('下午好', [temp, cond]), body: bitsText(bits) || null }
  }

  if (h === 20) {
    const tomorrowRange = rangeText(tomorrow.lo, tomorrow.hi)
    const bits = [
      tomorrow.textDay ? '明天' + tomorrow.textDay + (tomorrowRange ? ' ' + tomorrowRange : '') : '',
      tomorrow.textDay ? '' : (today.textNight ? '夜间' + today.textNight : ''),
      '早点休息'
    ]
    return { level: 'strong', title: headline('晚间', [today.textNight || cond, tempText(today.lo)]), body: bitsText(bits) || null }
  }

  // 09:00（以及自定义档位）按早安口径：今天白天 + 降水 + 风 + 紫外线
  const uv = num(today.uvIndex)
  const bits = [
    today.textDay ? '白天' + today.textDay : '',
    pop == null ? '' : '降水概率 ' + Math.round(pop) + '%',
    wind,
    pop != null && pop >= 40 ? '出门带伞' : '',
    uv != null && uv >= 7 ? '紫外线强' : ''
  ]
  return {
    level: 'strong',
    title: headline('早安', [cond, rangeText(today.lo, today.hi) || temp]),
    body: bitsText(bits) || null
  }
}

module.exports = {
  clock: clock, dayText: dayText, gapText: gapText,
  scheduleReminder: scheduleReminder, scheduleToday: scheduleToday,
  todoRemind: todoRemind, todoDue: todoDue,
  parcel: parcel, mailDigest: mailDigest, weatherAlert: weatherAlert, weatherDigest: weatherDigest,
  pomodoroDone: pomodoroDone, pomodoroBreakOver: pomodoroBreakOver
}
