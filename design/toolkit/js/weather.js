(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]

function renderHero() {
  const s = getState()
  const city = s.cities.find(c => c.name === s.weatherCity) || s.cities[0]
  const t = $('.hero-temp')
  if (t) t.innerHTML = city.temp + '<sub>°</sub>'
  $$('.hero-icon use').forEach(u => u.setAttribute('href', city.temp >= 30 ? '#i-sun' : city.temp <= 15 ? '#i-cloud' : '#i-partly'))
  const cond = $('.hero-cond')
  if (cond) cond.textContent = city.temp >= 30 ? '晴' : city.temp <= 15 ? '多云转阴' : '多云'
}

function renderCities() {
  const s = getState()
  const list = $('.drawer-list')
  if (!list) return
  list.innerHTML = s.cities.map((c, i) => `<div class="drawer-row" data-i="${i}"><span class="cn">${c.pinned ? '<svg style="width:13px;height:13px;vertical-align:middle"><use href="#i-pin"/></svg>' : ''}${esc(c.name)}</span><span class="tag">${esc(c.tag)}</span><span class="ct">${c.temp}°</span><button class="del" type="button" aria-label="删除${esc(c.name)}"${c.pinned ? ' disabled' : ''}><svg><use href="#i-trash"/></svg></button></div>`).join('')
  $$('.drawer-row', list).forEach(row => {
    row.onclick = e => {
      if (e.target.closest('.del')) return
      const c = s.cities[+row.dataset.i]
      setState(x => x.weatherCity = c.name)
      renderHero(); toast('已切换到 ' + c.name); location.hash = ''
    }
    row.querySelector('.del').onclick = e => {
      e.stopPropagation()
      const c = s.cities[+row.dataset.i]
      confirmDialog('删除城市', '确定从城市列表移除「' + esc(c.name) + '」？', () => { setState(x => x.cities.splice(+row.dataset.i, 1)); renderCities(); toast('已移除') }, '删除')
    }
  })
}

document.addEventListener('DOMContentLoaded', () => {
  renderHero(); renderCities()
  // 刷新：模拟加载缓存
  $$('.head-actions .ghost-btn').forEach(b => b.onclick = e => {
    if (!b.textContent.includes('刷新')) return
    e.preventDefault()
    location.hash = '#loading-state'
    setTimeout(() => { location.hash = ''; toast('天气数据已从本机缓存刷新') }, 700)
  })
  const add = $('.drawer-foot .primary-btn')
  if (add) add.onclick = () => {
    const name = prompt('输入城市名称（演示：使用内置模拟数据）')
    if (!name?.trim()) return
    setState(s => s.cities.push({ name: name.trim(), tag: '关注', temp: 20 + Math.floor(Math.random()*12) }))
    renderCities(); toast('已添加城市 ' + name.trim())
  }
  const search = $('.drawer-search input')
  if (search) search.oninput = () => {
    const q = search.value.trim()
    $$('.drawer-row').forEach(r => r.style.display = !q || r.textContent.includes(q) ? '' : 'none')
  }
  // 预警详情
  $$('.alert .text-btn').forEach(a => a.onclick = e => { e.preventDefault(); location.hash = '#city-drawer' })
  // 关注按钮等静态元素提示
  $$('.life-item').forEach(el => el.onclick = () => toast('生活指数依据当前天气生成'))
})
})()
