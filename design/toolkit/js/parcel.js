(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
let tab = '全部'

const statusTag = s => s === '待取件' ? 'warn' : s === '派送中' ? 'blue' : s === '已签收' ? 'gray' : ''

function visible() { const s = getState(); return tab === '全部' ? s.parcels : s.parcels.filter(p => p.status === tab) }

function renderCards() {
  const arr = visible(), grid = $('.pc-grid')
  if (!grid) return
  grid.innerHTML = arr.map(p => `<article class="pc-card${p.status==='已签收'?' muted-card':''}" data-id="${p.id}"><div class="pc-head"><span class="pc-logo">${esc(p.logo)}</span><div><strong>${esc(p.co)}</strong></div><span class="tag ${statusTag(p.status)}">${esc(p.status)}</span></div><div class="pc-num"><span class="${getState().privacy ? 'masked' : ''}">${esc(p.num)}</span><button class="copy-btn" type="button" title="复制单号"><svg><use href="#i-copy"/></svg></button></div><div class="pc-note">${esc(p.note)}</div><div class="pc-key"><strong>${esc(p.key)}</strong><span>${esc(p.sub)}</span></div><div class="pc-foot"><span>更新 ${esc(p.update)}</span><a class="text-btn" href="#drawer-state">查看轨迹</a></div></article>`).join('')
  grid.querySelectorAll('.pc-card').forEach(c => {
    c.querySelector('.copy-btn').onclick = e => { e.stopPropagation(); navigator.clipboard?.writeText(getState().parcels.find(x=>x.id===c.dataset.id).num); toast('单号已复制') }
    c.querySelector('.text-btn').onclick = () => openTrack(c.dataset.id)
  })
  $('.pc-empty')?.classList.toggle('show', arr.length === 0)
}

function openTrack(id) {
  const p = getState().parcels.find(x => x.id === id)
  const d = $('.drawer')
  if (!p || !d) return
  d.innerHTML = `<div class="drawer-head"><h2>${esc(p.co)} · ${esc(p.num)}</h2><a class="close-x" href="parcel.html" title="关闭"><svg><use href="#i-x"/></svg></a></div><div class="drawer-body"><div class="pc-status"><span class="tag ${statusTag(p.status)}">${esc(p.status)}</span></div><div class="field"><span class="k">收件人</span><span class="v">张三 · 138****1234</span></div><div class="field"><span class="k">地址</span><span class="v">佛山市禅城区 XX 路 12 号</span></div><div class="pc-track-title">物流轨迹</div><div class="pc-track">${p.track.map((x,i) => `<div class="pc-node${i===0?' now':''}">${i===0?'<span class="tag">最新</span>':''}<b>${esc(x.b)}</b><small>${esc(x.s)}</small><time>${esc(x.t)}</time></div>`).join('')}</div></div><div class="drawer-foot"><a class="ghost-btn" href="parcel.html">刷新轨迹</a><a class="ghost-btn" href="todo.html" data-todo>生成取件待办</a><a class="ghost-btn" href="parcel.html" data-archive>归档</a></div>`
  d.querySelector('[data-todo]').onclick = e => { e.preventDefault(); setState(s => s.todos.unshift({ id: uid(), title: '取' + p.co + '快递', list: '生活', priority: '中', due: '今天 21:00', done: false, subs: [] })); toast('已生成取件待办'); location.hash = '' }
  d.querySelector('[data-archive]').onclick = e => { e.preventDefault(); confirmDialog('归档包裹', '确定归档该包裹？', () => { setState(s => s.parcels = s.parcels.filter(x=>x.id!==id)); location.hash=''; renderCards(); renderCounter(); toast('已归档') }, '归档') }
}

function renderCounter() {
  const s = getState()
  const sub = $('.page-sub')
  if (sub) sub.textContent = `共 ${s.parcels.length} 个包裹 · ${s.parcels.filter(p=>p.status==='待取件').length} 个待取件 · 最后刷新 3 分钟前`
  $$('.pc-tabs a').forEach(a => { const m = a.textContent.match(/\d+/); if (m) a.querySelector('span').textContent = a.textContent.includes('全部') ? s.parcels.length : s.parcels.filter(p=>p.status===a.textContent.trim().split(' ')[0]).length })
}

document.addEventListener('DOMContentLoaded', () => {
  renderCards(); renderCounter()
  $$('.pc-tabs a').forEach(a => a.onclick = e => { e.preventDefault(); $$('.pc-tabs a').forEach(x=>x.classList.remove('on')); a.classList.add('on'); tab = a.textContent.trim().split(' ')[0]; renderCards() })
  const sw = $('.privacy .switch')
  if (sw) sw.onclick = () => { setState(s => s.privacy = !s.privacy); sw.classList.toggle('on', getState().privacy); renderCards(); toast(getState().privacy ? '隐私模式已开启' : '已显示完整单号') }
  const save = $('.modal-mask .primary-btn')
  if (save) save.onclick = e => {
    e.preventDefault()
    const num = $('.modal-body textarea')?.value?.trim().split('\n').filter(Boolean)
    if (!num?.length) { toast('请输入快递单号'); return }
    setState(s => num.forEach(n => s.parcels.unshift({ id: uid(), co: guess(n), logo: guess(n).slice(0,2).toUpperCase(), num: n, note: $('.modal-body .input')?.value||'', status: '在途', key: '等待物流更新', sub: '已添加至本机', update: '刚刚', track: [{ b: '已添加', s: '等待首次物流更新', t: '刚刚' }] })))
    location.hash = ''; renderCards(); renderCounter(); toast('快递已添加')
  }
  $$('.head-actions .ghost-btn').forEach(b => b.onclick = e => { if (b.textContent.includes('刷新')) { e.preventDefault(); toast('已刷新全部包裹（本机缓存）') } })
})
function guess(n) { return n.startsWith('SF') ? '顺丰速运' : n.startsWith('ZT') ? '中通快递' : n.startsWith('JD') ? '京东物流' : n.startsWith('YT') ? '圆通速递' : '其他快递' }
})()
