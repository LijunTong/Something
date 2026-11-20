(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
let folder = '统一收件箱'

function visible() {
  const s = getState()
  if (folder === '统一收件箱') return s.mails
  if (folder === '星标') return s.mails.filter(m => m.star)
  if (folder === '草稿') return s.mails.filter(m => m.tag === '草稿')
  return s.mails
}

function renderList() {
  const list = $('.ml-list'); if (!list) return
  const arr = visible()
  const old = list.querySelector('.ml-items'); if (old) old.remove()
  const wrap = document.createElement('div'); wrap.className = 'ml-items'
  wrap.innerHTML = arr.map(m => `<div class="ml-row${m.id === (getState().mails.find(x=>x.selected)?.id) ? ' sel' : ''}${m.unread ? ' unread' : ''}" data-id="${m.id}"><span class="ml-dot"></span><a class="ml-star" href="mail.html" title="星标"><svg><use href="#i-star"/></svg></a><div class="ml-body"><div class="ml-line"><strong>${esc(m.from)}</strong><time>${esc(m.time)}</time></div><div class="ml-subj">${esc(m.subj)}</div><div class="ml-sum">${esc(m.sum)}${m.attach ? '<svg style="width:12px;height:12px;vertical-align:middle"><use href="#i-paperclip"/></svg>' : ''}</div></div>${m.important ? '<span class="tag warn">重要</span>' : ''}</div>`).join('')
  list.insertBefore(wrap, list.querySelector('.ml-empty'))
  wrap.querySelectorAll('.ml-row').forEach(row => {
    row.onclick = () => openMail(row.dataset.id)
    row.querySelector('.ml-star').onclick = e => { e.stopPropagation(); const m = getState().mails.find(x=>x.id===row.dataset.id); setState(s => s.mails.find(x=>x.id===row.dataset.id).star = !m.star); renderList(); toast(m.star ? '已取消星标' : '已加星标') }
  })
  list.querySelector('.ml-empty')?.classList.toggle('show', arr.length === 0)
}

function openMail(id) {
  const s = getState()
  s.mails.forEach(m => { m.selected = m.id === id; if (m.id === id) m.unread = false })
  setState(x=>{}); renderList(); renderRead(); renderCounter()
}

function renderRead() {
  const m = getState().mails.find(x => x.selected); const r = $('.ml-read'); if (!r) return
  if (!m) { r.innerHTML = '<div style="padding:24px;color:var(--muted);font-size:13px">选择一封邮件阅读</div>'; return }
  r.innerHTML = `<div class="ml-tools"><a class="close-x" href="mail.html" title="回复"><svg><use href="#i-reply"/></svg></a><a class="close-x" href="mail.html" title="转发"><svg><use href="#i-send"/></svg></a><a class="close-x" data-star href="mail.html" title="星标"><svg><use href="#i-star"/></svg></a><a class="close-x" data-del href="mail.html" title="删除"><svg><use href="#i-trash"/></svg></a><a class="close-x" href="mail.html" title="打印"><svg><use href="#i-print"/></svg></a><span style="flex:1"></span><a class="text-btn" href="mail.html" data-unread>标记未读</a></div><div class="ml-content"><h2>${esc(m.subj)}</h2><div class="ml-from"><span class="ml-avatar">${esc(m.from[0])}</span><div><strong>${esc(m.from)}</strong><span>&lt;${esc(m.addr)}&gt;</span></div><time>今天 ${esc(m.time)}</time></div><div class="ml-to"><span>收件人：我</span></div><div class="ml-tagline">${m.important ? '<span class="tag warn">重要</span>' : ''}<span class="tag">${esc(m.tag)}</span></div><div class="ml-safe"><svg><use href="#i-lock"/></svg>远程图片已被拦截，以保护您的隐私<a class="text-btn" href="mail.html" data-img>显示图片</a></div>${m.body.map(p => '<p>'+esc(p)+'</p>').join('')}${m.attach ? '<div class="ml-attach"><span class="ml-attach-ico"><svg><use href="#i-paperclip"/></svg></span><div><strong>'+esc(m.attach)+'</strong><span>248 KB · PDF</span></div><a class="text-btn" href="mail.html" data-dl>下载</a></div>' : ''}<div class="ml-reply"><input class="input" placeholder="快速回复…"/><a class="primary-btn" href="mail.html" data-reply>回复</a></div></div>`
  r.querySelector('[data-star]').onclick = e => { e.preventDefault(); setState(s => s.mails.find(x=>x.id===m.id).star = !m.star); renderList() }
  r.querySelector('[data-del]').onclick = e => { e.preventDefault(); setState(s => s.mails = s.mails.filter(x=>x.id!==m.id)); renderList(); renderRead(); renderCounter(); toast('邮件已删除') }
  r.querySelector('[data-unread]').onclick = e => { e.preventDefault(); setState(s => s.mails.find(x=>x.id===m.id).unread = true); renderList(); toast('已标记未读') }
  r.querySelector('[data-reply]').onclick = e => { e.preventDefault(); const v = r.querySelector('.ml-reply input').value; if (!v.trim()) { toast('请输入回复内容'); return } toast('回复已发送（本地演示）'); r.querySelector('.ml-reply input').value = '' }
  r.querySelector('[data-img]')?.addEventListener('click', e => { e.preventDefault(); toast('出于隐私考虑，远程图片保持拦截') })
  r.querySelector('[data-dl]')?.addEventListener('click', e => { e.preventDefault(); toast('附件已下载（本地演示）') })
}

function renderCounter() {
  const s = getState(), n = s.mails.filter(m => m.unread).length
  const sub = $('.page-sub'); if (sub) sub.textContent = `未读 ${n} · 共 2 个账户 · 最后同步 2 分钟前`
  $$('.nav-item').forEach(x => { if (x.getAttribute('href') === 'mail.html') { const c = x.querySelector('.nav-count'); if (c) c.textContent = n } })
}

document.addEventListener('DOMContentLoaded', () => {
  renderList(); const first = getState().mails[0]; if (first) { setState(s => s.mails.forEach(m=>m.selected = m.id===first.id)); renderRead() }
  renderCounter()
  $$('.ml-nav').forEach(n => n.onclick = e => { e.preventDefault(); $$('.ml-nav').forEach(x=>x.classList.remove('on','on2')); n.classList.add(n.textContent.includes('统一')?'on':'on2'); folder = n.childNodes[n.childNodes.length-1]?.textContent?.trim()?.replace(/\d+/,'')?.trim() || n.textContent.trim().replace(/\d+/g,''); renderList() })
  const search = $('.ml-search'); if (search) search.oninput = () => { const q = search.value.trim(); $$('.ml-row').forEach(r => r.style.display = !q || r.textContent.includes(q) ? '' : 'none') }
  const compose = $('[href="#state-b"]')
  if (compose) compose.onclick = e => { e.preventDefault(); $('.compose').style.display = 'block' }
  $$('.compose .close-x').forEach(x => x.onclick = e => { e.preventDefault(); $('.compose').style.display = 'none' })
  $('.compose-foot .primary-btn')?.addEventListener('click', e => { e.preventDefault(); $('.compose').style.display = 'none'; toast('邮件已发送（本地演示）') })
  $('.compose-foot .ghost-btn')?.addEventListener('click', e => { e.preventDefault(); $('.compose').style.display = 'none'; toast('草稿已保存') })
  $$('.head-actions .ghost-btn').forEach(b => b.onclick = e => { if (b.textContent.includes('同步')) { e.preventDefault(); toast('同步完成：邮件来自本机缓存') } })
})
})()
