(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const HOUR0 = 8, PXPERHOUR = 66
const toTop = t => { const [h, m] = t.split(':').map(Number); return ((h - HOUR0) * 60 + m) / 60 * PXPERHOUR }
const toH = hh => String(hh).padStart(2, '0') + ':00'

let curDay = 1, calMonth = 10, calYear = 2026

function statusTag(s) { return s === '完成' ? '' : '<span class="tag warn">中断</span>' }

function renderWeek() {
  const s = getState()
  const grid = $('.sc-grid')
  if (!grid) return
  const cols = $$('.sc-col', grid)
  cols.forEach((col, i) => {
    const evs = s.schedules.filter(e => e.day === i && s.calendars.find(c => c.name === e.cat)?.on !== false)
    col.innerHTML = evs.map(e => `<a class="sc-ev ${e.color}" href="#drawer-state" data-id="${e.id}" style="top:${toTop(e.start)}px;height:${Math.max(30, toTop(e.end) - toTop(e.start))}px"><b>${esc(e.title)}</b><span>${e.start} - ${e.end}</span></a>`).join('')
  })
  grid.querySelectorAll('.sc-ev').forEach(el => el.onclick = () => openDetail(el.dataset.id))
}

function openDetail(id) {
  const s = getState(), e = s.schedules.find(x => x.id === id)
  if (!e) return
  s.schedules.forEach(x => x.selected = x.id === id)
  const d = $('.drawer')
  if (!d) return
  d.innerHTML = `<div class="drawer-head"><h2>${esc(e.title)}</h2><span><a class="close-x" href="#modal-state" style="display:inline-grid" title="编辑"><svg><use href="#i-edit"/></svg></a><a class="close-x" data-del title="删除" style="display:inline-grid"><svg><use href="#i-trash"/></svg></a><a class="close-x" href="schedule.html" title="关闭"><svg><use href="#i-x"/></svg></a></span></div>
  <div class="drawer-body">
    <div class="field"><span class="k">时间</span><span class="v">${toH(11 + e.day)}月${17 + e.day}日 ${e.start} - ${e.end}</span></div>
    <div class="field"><span class="k">地点</span><span class="v">${e.place ? '<svg style="width:13px;height:13px;vertical-align:middle"><use href="#i-pin"/></svg> ' + esc(e.place) : '—'}</span></div>
    <div class="field"><span class="k">日历分类</span><span class="v"><span class="dotc" style="background:${s.calendars.find(c=>c.name===e.cat)?.color||'#94a3b8'}"></span>${esc(e.cat)}</span></div>
    <div class="field"><span class="k">提醒</span><span class="v">${esc(e.remind)}</span></div>
    <div class="field"><span class="k">重复</span><span class="v">${esc(e.repeat)}</span></div>
    <div style="margin-top:14px"><span class="k muted" style="font-size:var(--fs-12)">备注</span><textarea data-note style="width:100%;min-height:80px;margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-btn);font:inherit;font-size:var(--fs-12)">${esc(e.note||'')}</textarea></div>
  </div>
  <div class="drawer-foot"><a class="primary-btn" href="pomodoro.html" style="text-align:center">开始专注</a><a class="ghost-btn" href="todo.html" style="text-align:center">转为待办</a></div>`
  d.querySelector('[data-del]').onclick = ev => { ev.preventDefault(); confirmDialog('删除日程', '确定删除「' + esc(e.title) + '」？', () => { setState(x => x.schedules = x.schedules.filter(z => z.id !== id)); location.hash = ''; renderWeek(); toast('已删除') }, '删除') }
  d.querySelector('[data-note]').onblur = ev => { setState(x => { x.schedules.find(z=>z.id===id).note = ev.target.value }) }
}

function renderMiniCal() {
  const first = new Date(calYear, calMonth, 1).getDay()
  const blank = (first + 6) % 7
  const days = new Date(calYear, calMonth + 1, 0).getDate()
  const grid = $('.mc-grid')
  if (!grid) return
  let html = ['一','二','三','四','五','六','日'].map(w => `<span class="wd">${w}</span>`).join('')
  for (let i = 0; i < blank; i++) html += '<span class="d blank">·</span>'
  for (let d = 1; d <= days; d++) html += `<span class="d${d===19&&calMonth===10?' today':''}">${d}</span>`
  grid.innerHTML = html
  $('.mc-head span:first-child').textContent = `${calYear} 年 ${calMonth+1} 月`
}

function renderCalCheck() {
  const s = getState()
  $$('.cal-check').forEach(l => {
    const cb = l.querySelector('input')
    const name = l.querySelector('.dotc')?.nextSibling?.textContent?.trim()
    const cal = s.calendars.find(c => c.name === name)
    cb.checked = cal ? cal.on : true
    cb.onchange = () => { if (cal) { setState(x => { x.calendars.find(c=>c.name===name).on = cb.checked }); renderWeek() } }
  })
}

function renderNowLine() {
  const now = new Date(), h = now.getHours() + now.getMinutes() / 60
  if (h < HOUR0 || h > 20) return
  const line = $('.sc-nowline')
  if (line) { line.style.top = toTop(toH(Math.floor(h))) + 'px'; line.querySelector('span').textContent = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') }
}

document.addEventListener('DOMContentLoaded', () => {
  renderWeek(); renderMiniCal(); renderCalCheck(); renderNowLine()
  $$('.mc-head .nav-group a').forEach((a, i) => a.onclick = e => { e.preventDefault(); calMonth += i === 0 ? -1 : 1; if (calMonth<0){calMonth=11;calYear--} if(calMonth>11){calMonth=0;calYear++} renderMiniCal() })
  const save = $('.modal-mask .primary-btn')
  if (save) save.onclick = e => {
    e.preventDefault()
    const inputs = $$('.modal-body .input')
    const title = inputs[0]?.value
    const start = inputs[1]?.value?.slice(-5)
    const end = inputs[2]?.value?.slice(-5)
    const sel = $$('.modal-body select')
    const cat = sel[0]?.value || '工作'
    if (!title?.trim() || !start || !end) { toast('请填写标题和起止时间'); return }
    const color = cat === '个人' ? 'orange' : cat === '学习' ? 'green' : 'blue'
    setState(s => s.schedules.push({ id: uid(), title: title.trim(), day: curDay, start, end, color, place: inputs[3]?.value || '', cat, remind: sel[1]?.value || '提前 10 分钟', repeat: sel[2]?.value || '不重复', note: inputs[4]?.value || '' }))
    location.hash = ''; renderWeek(); toast('日程已创建')
  }
  // 视图切换
  $$('.head-actions .seg button').forEach(b => b.onclick = () => { $$('.head-actions .seg button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); toast('已切换到' + b.textContent + '视图') })
  // 今天按钮
  const today = $('.nav-group span')
  if (today) today.onclick = () => { curDay = 1; toast('已回到今天') }
  // ICS 导入导出（本地模拟）
  $$('.head-actions .text-btn').forEach(a => a.onclick = e => { if (a.textContent.includes('ICS')) { e.preventDefault(); toast('ICS 导入/导出功能（本地演示）'); location.hash = '#modal-state' } })
})
})()
