(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]

function render() {
  const s = getState()
  // 顶部日期
  const now = new Date()
  const weeks = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六']
  const dateSub = $('.page-head .page-sub')
  if (dateSub) dateSub.textContent = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日 ${weeks[now.getDay()]} · 数据更新于 ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}（本地缓存）`
  // 侧栏角标
  const counts = { 'todo.html': s.todos.filter(t=>!t.done).length, 'schedule.html': s.schedules.length, 'feed.html': s.feeds.filter(f=>!f.read).length, 'mail.html': s.mails.filter(m=>m.unread).length }
  $$('.nav-item').forEach(n => { const c = n.querySelector('.nav-count'); if (c && counts[n.getAttribute('href')] !== undefined) c.textContent = counts[n.getAttribute('href')] })
  // 首页天气
  const city = s.cities.find(c=>c.name===s.weatherCity) || s.cities[0]
  const wt = $('.wc-temp'); if (wt) wt.innerHTML = city.temp + '<sub>°</sub>'
  const wcTitle = $('#c-weather'); if (wcTitle) wcTitle.textContent = '天气 · ' + s.weatherCity
  $$('.wc-main .wc-icon use').forEach(u => u.setAttribute('href', '#i-partly'))
  // 今日待办列表
  const todoCard = $('[aria-labelledby="c-todo"]')
  if (todoCard) {
    const tasks = s.todos.filter(t=>!t.done).slice(0,4)
    const rows = todoCard.querySelectorAll('.todo-item')
    tasks.forEach((t,i) => { const row = rows[i]; if (!row) return; row.style.display=''; const cb=row.querySelector('input'); const strong=row.querySelector('strong'); const small=row.querySelector('small'); if(strong)strong.textContent=t.title; if(small)small.textContent=(t.due||'')+(t.list?' · '+t.list:''); if(cb){cb.checked=t.done; cb.onchange=()=>{setState(x=>{const z=x.todos.find(a=>a.title===t.title); if(z)z.done=cb.checked}); render(); toast(cb.checked?'已完成':'已恢复')}} })
    for (let i=tasks.length;i<rows.length;i++) rows[i].style.display='none'
    const foot = todoCard.querySelector('.card-foot')
    if (foot) foot.innerHTML = `今日剩余 <strong>${s.todos.filter(t=>!t.done).length}</strong> 项 · 已完成 <strong>${s.todos.filter(t=>t.done).length}</strong> 项`
  }
  // 今日日程
  const scCard = $('[aria-labelledby="c-schedule"]')
  if (scCard) {
    const items = scCard.querySelectorAll('.timeline-item')
    const evs = s.schedules.filter(e=>e.day===1).slice(0,3)
    evs.forEach((e,i)=>{ const it=items[i]; if(!it)return; const strong=it.querySelector('.t-body strong'); if(strong)strong.textContent=e.title; const p=it.querySelector('p'); if(p)p.textContent=(e.place||'—')+' · 已开启提前提醒' })
  }
  // 邮件未读
  const mailCard = $('[aria-labelledby="c-mail"]')
  if (mailCard) { const t=mailCard.querySelector('.card-title'); if(t)t.textContent='邮件 · 未读 '+s.mails.filter(m=>m.unread).length }
  // 信息流未读
  const feedCard = $('[aria-labelledby="c-feed"]')
  if (feedCard) { const t=feedCard.querySelector('.tag'); if(t)t.textContent='未读 '+s.feeds.filter(f=>!f.read).length }
  // 快递
  const parcelCard = $('[aria-labelledby="c-parcel"]')
  if (parcelCard) { const p=parcelCard.querySelector('.card-foot'); if(p)p.textContent='最近刷新 20:08 · 共 '+s.parcels.length+' 个包裹（本机缓存）' }
  // 通知计数
  const bell = $('.notification .badge')
  if (bell) bell.textContent = s.notices.length
}

document.addEventListener('DOMContentLoaded', () => {
  render()
  // 城市切换 chip
  $$('.wc-top .city-chip').forEach(chip => chip.onclick = () => {
    $$('.wc-top .city-chip').forEach(c=>c.classList.remove('active')); chip.classList.add('active')
    setState(s => s.weatherCity = chip.textContent); render(); toast('已切换到 ' + chip.textContent)
  })
  // 全部已读
  const readAll = $('[href="#notice-empty"]')
  if (readAll) readAll.onclick = e => { e.preventDefault(); setState(s=>s.notices=[]); location.hash='#notice-empty'; toast('已全部标记为已读') }
  // 恢复提醒
  const restore = $('.notice-empty a')
  if (restore) restore.onclick = e => { e.preventDefault(); setState(s=>s.notices=[{ico:'clock',warn:true,title:'14:00 需求评审即将开始',sub:'日程提醒 · 13:50'},{ico:'box',title:'顺丰快递已到驿站',sub:'快递状态 · 20:06'},{ico:'mail',title:'工作邮箱有 2 封重要未读邮件',sub:'邮件提醒 · 19:58'}]); location.hash=''; toast('提醒列表已恢复'); setTimeout(()=>location.reload(),300) }
  // 各卡片按钮跳转
  $$('.card .text-btn').forEach(b => { if (!b.getAttribute('href')?.startsWith('#')) return })
})
})()
