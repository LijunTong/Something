(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
let timer = null, remain = 0, running = false

function fmt(sec) { return String(Math.floor(sec/60)).padStart(2,'0') + ':' + String(sec%60).padStart(2,'0') }

function paint() {
  const p = getState().pomodoro
  const t = fmt(remain)
  $$('.pm-time, .pm-focus-time').forEach(el => { if (el) el.textContent = t })
  const cap = $('.pm-cap')
  if (cap) cap.textContent = `距离结束还有 ${Math.floor(remain/60)} 分 ${remain%60} 秒`
  const tag = $('.pm-timer .tag')
  if (tag) tag.textContent = running ? '专注中' : '已暂停'
  document.title = (running ? '▶ ' : '⏸ ') + t + ' · 番茄钟'
}

function start() {
  if (running) return
  running = true
  timer = setInterval(() => {
    if (remain <= 0) { finish(); return }
    remain--
    setState(s => s.pomodoro.focusSeconds = remain)
    paint()
  }, 1000)
  paint(); toast('开始专注')
}
function pause() { running = false; clearInterval(timer); timer = null; paint(); toast('已暂停') }
function finish() {
  running = false; clearInterval(timer); timer = null
  setState(s => { s.pomodoro.todayCount++; s.pomodoro.focusSeconds = s.pomodoro.focusMin * 60; s.pomodoro.sessions.unshift({ t: s.pomodoro.task, min: s.pomodoro.focusMin, time: nowRange(), status: '完成' }) })
  remain = getState().pomodoro.focusMin * 60
  paint(); renderAll(); toast('番茄完成！休息一下 🎉')
}
function nowRange() {
  const n = new Date(), end = n.getHours()*60+n.getMinutes(), start = end - getState().pomodoro.focusMin
  const f = m => String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')
  return f(start) + '-' + f(end)
}
function giveUp() {
  confirmDialog('放弃本次专注', '当前进度将记录为一次中断，确定放弃吗？', () => {
    pause(); setState(s => s.pomodoro.sessions.unshift({ t: s.pomodoro.task, min: Math.round((getState().pomodoro.focusMin*60-remain)/60), time: nowRange(), status: '中断' }))
    remain = getState().pomodoro.focusMin * 60; setState(s => s.pomodoro.focusSeconds = remain); paint(); renderAll(); toast('已记录中断')
  }, '确认放弃')
}

function renderAll() {
  const p = getState().pomodoro
  const dots = $('.pm-dots')
  if (dots) dots.innerHTML = Array.from({ length: p.goal }, (_, i) => `<i class="${i < p.todayCount % p.goal ? 'on' : ''}"></i>`).join('') + `<span>本轮第 ${(p.todayCount % p.goal) + 1}/${p.goal} 个番茄</span>`
  const stat = $$('.pm-stats strong')
  if (stat.length >= 4) { stat[0].textContent = p.todayCount; const mins = p.todayCount * p.focusMin; stat[1].textContent = Math.floor(mins/60)+'h'+(mins%60?'0'+mins%60+'m':'') }
  const sessions = $('.pm-side .card:last-child')
  if (sessions) {
    const body = sessions.querySelector('.card-head')?.outerHTML || ''
    sessions.innerHTML = body + p.sessions.slice(0,5).map(x => `<div class="pm-session"><div><strong>${esc(x.t)}</strong><span class="tag ${x.status==='中断'?'warn':''}">${x.status}</span></div><span>${x.min} 分钟 · ${x.time}</span></div>`).join('')
  }
  const task = $('.pm-task strong')
  if (task) task.textContent = p.task
  const focusTask = $('.pm-focus-task')
  if (focusTask) focusTask.textContent = p.task
}

document.addEventListener('DOMContentLoaded', () => {
  const p = getState().pomodoro
  remain = p.focusSeconds || p.focusMin * 60
  paint(); renderAll()
  $$('.pm-actions a, .pm-focus-btns a').forEach(a => a.onclick = e => {
    const txt = a.textContent.trim()
    if (txt.includes('暂停')) { e.preventDefault(); running ? pause() : start(); a.textContent = running ? '暂停' : '继续' }
    else if (txt.includes('放弃') || txt.includes('结束')) { e.preventDefault(); giveUp() }
    else if (txt.includes('跳过')) { e.preventDefault(); pause(); remain = p.shortMin * 60; paint(); toast('进入休息：' + p.shortMin + ' 分钟') }
  })
  // 设置：点击配置文字调整时长
  const cfg = $('.pm-cfg')
  if (cfg) cfg.onclick = () => {
    const v = prompt('专注时长（分钟）', p.focusMin)
    if (v && +v > 0) { setState(s => { s.pomodoro.focusMin = +v; s.pomodoro.focusSeconds = +v*60 }); remain = +v*60; cfg.textContent = `专注 ${v} 分钟 · 短休 ${p.shortMin} 分钟 · 长休 ${p.longMin} 分钟`; paint(); toast('已更新专注时长') }
  }
  // 中断原因弹窗确认
  const confirm = $('.modal-mask .primary-btn')
  if (confirm) confirm.onclick = e => { e.preventDefault(); location.hash = ''; toast('中断原因已记录') }
})
})()
