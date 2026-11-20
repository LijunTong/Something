(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
let tab = '未读', fontScale = 1

function visible() {
  const s = getState()
  if (tab === '未读') return s.feeds.filter(f => !f.read)
  if (tab === '收藏') return s.feeds.filter(f => f.star)
  if (tab === '稍后读') return s.feeds.filter(f => f.later)
  return s.feeds
}

function renderList() {
  const el = $('.fd-list .seg')
  const list = $('.fd-list')
  const items = visible()
  const old = list.querySelector('.fd-items')
  if (old) old.remove()
  const wrap = document.createElement('div')
  wrap.className = 'fd-items'
  wrap.innerHTML = items.map(f => `<article class="fd-item${f.selected ? ' sel' : ''}${f.read ? '' : ' unread'}" data-id="${f.id}"><div class="fd-meta"><span>${esc(f.src)}</span><span>${esc(f.time)}</span></div><div class="fd-title">${esc(f.title)}</div><div class="fd-sum">${esc(f.sum)}</div></article>`).join('') || '<div class="fd-empty2" style="padding:20px;color:var(--muted);font-size:12px">这里还没有文章</div>'
  list.insertBefore(wrap, list.querySelector('.ghost-btn'))
  wrap.querySelectorAll('.fd-item').forEach(art => art.onclick = () => openArticle(art.dataset.id))
}

function openArticle(id) {
  const s = getState()
  s.feeds.forEach(f => { f.selected = f.id === id; if (f.id === id) f.read = true })
  setState(x => {})
  renderList(); renderReader(); renderCounter()
}

function renderReader() {
  const f = getState().feeds.find(x => x.selected)
  const r = $('.fd-reader')
  if (!r) return
  if (!f) { r.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:13px">选择左侧文章开始阅读</div>'; return }
  r.innerHTML = `<div class="fd-tools"><a class="close-x" href="feed.html" title="返回"><svg><use href="#i-chev-l"/></svg></a><span class="fd-font"><button class="ghost-btn" data-sm type="button">A-</button><button class="ghost-btn" data-lg type="button">A+</button></span><a class="close-x" data-dark href="#state-b" title="夜间模式"><svg><use href="#i-moon"/></svg></a><a class="close-x" data-star href="feed.html" title="收藏"><svg><use href="#i-star"/></svg></a><a class="close-x" data-later href="feed.html" title="稍后读"><svg><use href="#i-clock"/></svg></a><span style="flex:1"></span><a class="text-btn" href="todo.html" data-todo>转为待办</a><a class="close-x" href="feed.html" title="更多"><svg><use href="#i-more"/></svg></a></div>
  <div class="fd-article" style="font-size:${(14*fontScale).toFixed(0)}px">
    <h2>${esc(f.title)}</h2><div class="fd-byline">${esc(f.src)} · ${esc(f.by)} · ${esc(f.time)}</div>
    ${f.body.map(p => '<p>' + esc(p) + '</p>').join('')}
    <blockquote>工具应当让人掌控数据，而不是让人迁移到数据所在的地方。</blockquote>
    <div class="fd-origin"><span>原文链接：${esc(f.origin)}</span><a class="primary-btn" href="${esc(f.origin)}" target="_blank" rel="noopener">打开原文</a></div>
  </div>`
  r.querySelector('[data-star]').onclick = e => { e.preventDefault(); setState(x => x.feeds.find(z=>z.id===f.id).star = !x.feeds.find(z=>z.id===f.id).star); toast(f.star ? '已取消收藏' : '已收藏'); renderList() }
  r.querySelector('[data-later]').onclick = e => { e.preventDefault(); setState(x => x.feeds.find(z=>z.id===f.id).later = !x.feeds.find(z=>z.id===f.id).later); toast(f.later ? '已移出稍后读' : '已加入稍后读'); renderList() }
  r.querySelector('[data-dark]').onclick = e => { e.preventDefault(); location.hash = location.hash === '#state-b' ? '' : '#state-b' }
  r.querySelector('[data-sm]').onclick = () => { fontScale = Math.max(.8, fontScale-.1); renderReader() }
  r.querySelector('[data-lg]').onclick = () => { fontScale = Math.min(1.6, fontScale+.1); renderReader() }
  r.querySelector('[data-todo]').onclick = e => { e.preventDefault(); setState(x => x.todos.unshift({ id: uid(), title: '阅读：' + f.title, list: '学习', priority: '中', due: '', done: false, subs: [] })); toast('已转为待办') }
}

function renderCounter() {
  const s = getState(), n = s.feeds.filter(f => !f.read).length
  const sub = $('.page-sub')
  if (sub) sub.textContent = `${n} 篇未读 · 共 ${s.sources.length} 个订阅源 · 最后抓取 10 分钟前`
  $$('.nav-item').forEach(x => { if (x.getAttribute('href') === 'feed.html') { const c = x.querySelector('.nav-count'); if (c) c.textContent = n } })
}

document.addEventListener('DOMContentLoaded', () => {
  const first = getState().feeds.find(f => !f.read)
  if (first) { getState().feeds.forEach(f => f.selected = f.id === first.id); renderList(); renderReader() }
  else renderList()
  renderCounter()
  $$('.fd-list .seg button').forEach(b => b.onclick = () => { $$('.fd-list .seg button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); tab = b.textContent; renderList() })
  $$('.fd-nav').forEach(n => n.onclick = e => { e.preventDefault(); const t = n.textContent; tab = t.includes('未读') ? '未读' : t.includes('收藏') ? '收藏' : t.includes('稍后读') ? '稍后读' : '全部'; $$('.fd-list .seg button').forEach(b => b.classList.toggle('on', b.textContent === tab)); renderList() })
  $$('.head-actions .ghost-btn').forEach(b => b.onclick = e => { if (b.textContent.includes('刷新')) { e.preventDefault(); toast('已刷新，所有订阅源自本机缓存读取') } })
  const save = $('.modal-mask .primary-btn')
  if (save) save.onclick = e => {
    e.preventDefault()
    const inputs = $$('.modal-body .input')
    const url = inputs[0]?.value, group = $$('.modal-body select')[0]?.value
    if (!url) { toast('请输入 RSS 链接'); return }
    setState(x => x.sources.push({ name: url.slice(0,30), group, on: true }))
    location.hash = ''; renderCounter(); toast('订阅源已添加')
  }
})
})()
