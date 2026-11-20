(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
let filter = '全部'

function visibleTasks() {
  const s = getState()
  let list = s.todos
  if (filter === '未完成') list = list.filter(t => !t.done)
  if (filter === '高优先级') list = list.filter(t => t.priority === '高')
  if (filter === '有截止时间') list = list.filter(t => t.due)
  return list
}

function renderList() {
  const s = getState()
  const tasks = visibleTasks()
  const listEl = $('.td-list')
  if (!listEl) return
  if (!tasks.length) { $('.td-empty')?.classList.add('show'); listEl.innerHTML = ''; return }
  $('.td-empty')?.classList.remove('show')
  listEl.innerHTML = tasks.map(t => `
  <div class="td-row${t.done ? ' done' : ''}${t.selected ? ' selected' : ''}" data-id="${t.id}">
    <label class="td-task"><input type="checkbox"${t.done ? ' checked' : ''}/><span class="checkbox"></span><span class="td-title">${esc(t.title)}</span></label>
    <span class="td-tags">${t.priority === '高' ? '<span class="tag warn">高</span>' : ''}<span class="tag">${esc(t.list)}</span></span>
    <span class="td-due${t.over ? ' over' : ''}">${esc(t.due || '')}</span>
    <a class="td-more" href="#drawer-state" title="更多"><svg><use href="#i-more"/></svg></a>
  </div>`).join('')
}

function renderDetail() {
  const t = getState().todos.find(x => x.selected)
  const panel = $('.td-detail')
  if (!panel || !t) return
  const subs = t.subs || []
  const doneN = subs.filter(x => x.done).length
  panel.innerHTML = `
    <div class="td-dhead"><label class="td-task"><input type="checkbox"${t.done ? ' checked' : ''}/><span class="checkbox"></span><strong>${esc(t.title)}</strong></label><a class="close-x" href="todo.html" title="收起"><svg><use href="#i-x"/></svg></a></div>
    <div class="field"><span class="k">清单</span><span class="v"><span class="dotc" style="background:#2563eb"></span>${esc(t.list)}</span></div>
    <div class="field"><span class="k">优先级</span><span class="v"><span class="tag ${t.priority === '高' ? 'warn' : ''}">${esc(t.priority)}</span></span></div>
    <div class="field"><span class="k">截止时间</span><span class="v">${esc(t.due || '无')}</span></div>
    <div class="field"><span class="k">提醒</span><span class="v">提前 30 分钟</span></div>
    <div class="field"><span class="k">标签</span><span class="v"><span class="tag">${esc(t.list)}</span></span></div>
    <div class="field"><span class="k">已投入专注</span><span class="v">1 小时 15 分</span></div>
    <div class="td-subtitle">子任务 ${doneN}/${subs.length}</div>
    <div class="td-subs">${subs.map((sub, i) => `<label class="td-sub"><input type="checkbox" data-sub="${i}"${sub.done ? ' checked' : ''}/><span class="checkbox" style="width:14px;height:14px"></span>${esc(sub.t)}</label>`).join('')}</div>
    <div class="td-note">备注<textarea data-note>${esc(t.note || '')}</textarea></div>
    <div class="td-actions"><a class="primary-btn" href="pomodoro.html">开始番茄专注</a><a class="ghost-btn" href="schedule.html">转为日程</a><button class="ghost-btn" data-del>删除任务</button></div>
  `
  panel.querySelector('.td-dhead input').onchange = e => toggleDone(t.id, e.target.checked)
  panel.querySelectorAll('[data-sub]').forEach(cb => cb.onchange = e => {
    setState(s => { const sub = s.todos.find(x => x.id === t.id).subs[+e.target.dataset.sub]; sub.done = e.target.checked })
    renderDetail(); renderCounters()
  })
  panel.querySelector('[data-note]').onblur = e => { setState(s => { s.todos.find(x => x.id === t.id).note = e.target.value }) }
  panel.querySelector('[data-del]').onclick = () => confirmDialog('删除任务', '确定删除「' + esc(t.title) + '」？', () => {
    setState(s => { s.todos = s.todos.filter(x => x.id !== t.id); const n = s.todos[0]; if (n) n.selected = true })
    renderAll(); toast('已删除任务')
  }, '删除')
}

function renderBoard() {
  const s = getState()
  const cols = { '未开始': [], '进行中': [], '已完成': [] }
  s.todos.forEach(t => { if (t.done) cols['已完成'].push(t); else if (t.selected) cols['进行中'].push(t); else cols['未开始'].push(t) })
  const b = $('.td-board')
  if (!b) return
  b.innerHTML = Object.entries(cols).map(([k, arr]) => `<div class="td-bcol"><b>${k} <span>${arr.length}</span></b>${arr.map(t => `<div class="td-bcard" data-id="${t.id}">${esc(t.title)}</div>`).join('')}</div>`).join('')
  $$('.td-bcard', b).forEach(el => el.onclick = () => { setState(s => s.todos.forEach(t => t.selected = t.id === el.dataset.id)); location.hash = ''; renderAll() })
}

function renderCounters() {
  const s = getState()
  const undone = s.todos.filter(t => !t.done).length
  const doneWeek = 18 + (6 - s.todos.filter(t => !t.done).length)
  const sub = $('.page-sub')
  if (sub) sub.textContent = `今日 ${undone} 项待完成 · 本周已完成 ${doneWeek} 项`
  $$('.td-nav').forEach(n => { const c = n.querySelector('span'); if (c && /^\d+$/.test(c.textContent)) c.textContent = n.textContent.includes('今天') ? undone : c.textContent })
  $$('.nav-item').forEach(n => { if (n.getAttribute('href') === 'todo.html') { const c = n.querySelector('.nav-count'); if (c) c.textContent = undone } })
}

function toggleDone(id, done) {
  setState(s => { const t = s.todos.find(x => x.id === id); if (t) t.done = done })
  renderAll(); toast(done ? '已完成' : '已标记为未完成')
}

function addTask(title) {
  if (!title.trim()) return
  setState(s => { s.todos.unshift({ id: uid(), title: title.trim(), list: '今天', priority: '中', due: '', done: false, subs: [], selected: true }); s.todos.forEach(t => t.selected = t.id === s.todos[0].id) })
  renderAll(); toast('任务已创建')
}

function renderAll() { renderList(); renderDetail(); renderBoard(); renderCounters() }

document.addEventListener('DOMContentLoaded', () => {
  renderAll()
  const quick = $('.td-quick input')
  quick?.addEventListener('keydown', e => { if (e.key === 'Enter') { addTask(quick.value); quick.value = '' } })
  $$('.td-filters .chip').forEach(chip => chip.onclick = () => { $$('.td-filters .chip').forEach(c => c.classList.remove('on')); chip.classList.add('on'); filter = chip.textContent; renderList() })
  $('.td-list')?.addEventListener('change', e => {
    const cb = e.target.closest('input[type=checkbox]')
    const row = e.target.closest('.td-row')
    if (cb && row) toggleDone(row.dataset.id, cb.checked)
    if (e.target.closest('.td-more')) return
  })
  $('.td-list')?.addEventListener('click', e => {
    const row = e.target.closest('.td-row')
    if (row && !e.target.closest('input') && !e.target.closest('.td-more')) { setState(s => s.todos.forEach(t => t.selected = t.id === row.dataset.id)); renderAll() }
  })
  // 保存按钮：新建任务
  const save = $('.modal-mask .primary-btn')
  if (save) save.onclick = e => {
    e.preventDefault()
    const body = $('.modal-mask .modal-body')
    const title = body.querySelector('input')?.value
    const list = body.querySelectorAll('select')[0]?.value
    const due = body.querySelectorAll('input')[1]?.value
    const priority = body.querySelectorAll('select')[1]?.value
    if (!title?.trim()) { toast('请输入任务标题'); return }
    setState(s => { s.todos.unshift({ id: uid(), title: title.trim(), list: list || '今天', priority: priority || '中', due: due || '', done: false, subs: [], selected: true }); s.todos.forEach(t => t.selected = t.id === s.todos[0].id) })
    location.hash = ''; renderAll(); toast('任务已创建')
  }
})
})()
