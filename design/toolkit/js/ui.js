(function(){
const { getState, setState } = window.TK
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let toastEl
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'tk-toast'; document.body.appendChild(toastEl) }
  toastEl.textContent = msg; toastEl.classList.add('show')
  clearTimeout(toastEl._t); toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2200)
}

const tkCss = document.createElement('style')
tkCss.textContent = `
.tk-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(12px);z-index:9999;padding:10px 18px;border-radius:10px;background:#1f2937;color:#fff;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.2);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}
.tk-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.dialog-mask{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42)}
.dialog{width:420px;max-width:92vw;border-radius:14px;background:#fff;box-shadow:0 24px 64px rgba(0,0,0,.24);overflow:hidden}
.dialog h3{margin:0;padding:16px 18px;font-size:14px;border-bottom:1px solid var(--border)}
.dialog .d-body{padding:16px 18px;font-size:13px;color:var(--muted);line-height:1.7}
.dialog .d-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--border);background:#fbfcfd}
.td-empty.show,.pc-empty.show,.ml-empty.show{display:flex}
.masked{letter-spacing:.5px}
`
document.head.appendChild(tkCss)

function confirmDialog(title, body, onOk, okLabel = '确定') {
  const mask = document.createElement('div'); mask.className = 'dialog-mask'
  mask.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><div class="d-body">${body}</div><div class="d-foot"><button class="ghost-btn" data-x>取消</button><button class="primary-btn" data-ok>${esc(okLabel)}</button></div></div>`
  document.body.appendChild(mask)
  const close = () => mask.remove()
  mask.querySelector('[data-x]').onclick = close
  mask.onclick = e => { if (e.target === mask) close() }
  mask.querySelector('[data-ok]').onclick = () => { close(); onOk() }
}

function applyTheme() {
  const s = getState().settings || {}
  const root = document.documentElement
  root.dataset.font = s.font || '小'
  if (s.accent) root.style.setProperty('--primary', s.accent)
  if (s.theme === '深色') {
    root.style.setProperty('--bg', '#0f172a'); root.style.setProperty('--surface', '#1e293b')
    root.style.setProperty('--text', '#e2e8f0'); root.style.setProperty('--muted', '#94a3b8'); root.style.setProperty('--border', '#334155')
    document.body.classList.add('dark-mode')
  }
}
applyTheme()

function doSearch(q) {
  q = q.trim().toLowerCase(); if (!q) return
  const s = getState(), hits = []
  s.todos.forEach(t => { if (t.title.toLowerCase().includes(q)) hits.push(['待办', t.title, 'todo.html']) })
  s.schedules.forEach(e => { if (e.title.toLowerCase().includes(q)) hits.push(['日程', e.title, 'schedule.html']) })
  s.feeds.forEach(f => { if (f.title.toLowerCase().includes(q)) hits.push(['文章', f.title, 'feed.html']) })
  s.parcels.forEach(p => { if (p.num.toLowerCase().includes(q) || p.co.includes(q)) hits.push(['快递', p.num + ' ' + p.co, 'parcel.html']) })
  s.mails.forEach(m => { if (m.subj.toLowerCase().includes(q) || m.from.includes(q)) hits.push(['邮件', m.subj, 'mail.html']) })
  if (!hits.length) { toast('没有找到匹配结果'); return }
  const rows = hits.slice(0, 8).map(([k, t, href]) => `<a href="${href}" class="sr-row"><span class="sr-kind">${k}</span><span>${esc(t)}</span></a>`).join('')
  const mask = document.createElement('div'); mask.className = 'dialog-mask'
  mask.innerHTML = `<div class="dialog" style="width:520px"><h3>搜索结果（${hits.length} 条）</h3><div class="d-body" style="padding:8px 0"><style>.sr-row{display:flex;gap:10px;padding:9px 18px;text-decoration:none;color:var(--text);font-size:13px}.sr-row:hover{background:var(--bg)}.sr-kind{flex:0 0 42px;color:var(--muted)}</style>${rows}</div><div class="d-foot"><button class="ghost-btn" data-x>关闭</button></div></div>`
  document.body.appendChild(mask)
  mask.querySelector('[data-x]').onclick = () => mask.remove()
  mask.onclick = e => { if (e.target === mask) mask.remove() }
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.querySelector('.search-box input')
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(input.value) } })
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input && input.focus() }
  })
  document.querySelectorAll('.top-actions .primary-btn').forEach(b => b.addEventListener('click', () => { location.href = 'todo.html#modal-state' }))
  document.querySelectorAll('.top-actions .notification, .top-actions .icon-btn').forEach(b => b.addEventListener('click', () => {
    if (location.pathname.split('/').pop() !== 'home.html') location.href = 'home.html'
  }))
})
window.TKUI = { esc, toast, confirmDialog, applyTheme }
})()
