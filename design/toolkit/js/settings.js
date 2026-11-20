(function(){
const { getState, setState, uid, subscribe, reset, exportJSON } = window.TK
const { esc, toast, confirmDialog, applyTheme } = window.TKUI

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]

function download(name, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href)
}

document.addEventListener('DOMContentLoaded', () => {
  // 所有 switch 开关：切换即持久化
  $$('.switch').forEach(sw => {
    const panel = sw.closest('.set-panel')
    const field = sw.closest('.field')
    const rule = sw.closest('.rule')
    sw.onclick = () => {
      sw.classList.toggle('on'); sw.classList.toggle('off')
      const on = sw.classList.contains('on')
      if (panel) {
        const id = panel.id
        const map = { 's-dashboard':'仪表盘','s-weather':'天气','s-schedule':'日程','s-todo':'待办','s-pomodoro':'番茄钟','s-feed':'信息流','s-parcel':'快递','s-mail':'邮件','s-data':'数据与存储','s-appearance':'外观','s-notify':'通知' }
        const name = map[id]
        if (name) setState(s => s.settings.modules[name] = on)
      } else if (field) {
        const k = field.querySelector('.k')?.textContent?.trim()
        if (k && getState().settings.notify.hasOwnProperty(k)) setState(s => s.settings.notify[k] = on)
        else if (k === '启用桌面通知' || k === '自动备份到本地目录' || k === '离线使用最近缓存' || k === '天气预警本地推送' || k === '为备份文件设置密码' || k === '始终展开 / 可折叠' || k === '离线保留文章正文') toast(k + (on ? '：已开启' : '：已关闭'))
      } else if (rule) toast('规则' + (on ? '已启用' : '已停用'))
      else toast(on ? '已开启' : '已关闭')
    }
  })
  // 主题
  $$('.set-themes .theme').forEach(t => t.onclick = () => {
    $$('.set-themes .theme').forEach(x=>x.classList.remove('on')); t.classList.add('on')
    setState(s => s.settings.theme = t.textContent); applyTheme(); location.reload()
  })
  // 强调色
  $$('.set-colors i').forEach(c => c.onclick = () => {
    $$('.set-colors i').forEach(x=>x.classList.remove('on')); c.classList.add('on')
    setState(s => s.settings.accent = c.style.background); applyTheme(); toast('强调色已更新')
  })
  // 字号
  $$('.set-panel#s-appearance .seg button').forEach(b => b.onclick = () => {
    $$('.set-panel#s-appearance .seg button').forEach(x=>x.classList.remove('on')); b.classList.add('on')
    setState(s => s.settings.font = b.textContent); applyTheme(); toast('字号已设为' + b.textContent)
  })
  // 导出
  const btns = $$('.set-btns a, .set-danger a')
  btns.forEach(b => {
    const t = b.textContent.trim()
    if (t.includes('导出全部数据')) b.onclick = e => { e.preventDefault(); download('efficiency-data.json', exportJSON(), 'application/json'); toast('已导出 JSON') }
    else if (t.includes('导出日程')) b.onclick = e => { e.preventDefault(); download('schedule.ics', 'BEGIN:VCALENDAR\nVERSION:2.0\n' + getState().schedules.map(s => 'BEGIN:VEVENT\nSUMMARY:'+s.title+'\nDTSTART:202611'+s.start.replace(':','')+'\nEND:VEVENT').join('\n') + '\nEND:VCALENDAR', 'text/calendar'); toast('已导出 ICS') }
    else if (t.includes('导出订阅源')) b.onclick = e => { e.preventDefault(); download('feeds.opml', '<?xml version="1.0"?><OPML><body>' + getState().sources.map(s => '<outline text="'+s.name+'" xmlUrl="'+s.name+'"/>').join('') + '</body></OPML>', 'text/xml'); toast('已导出 OPML') }
    else if (t.includes('从备份文件恢复')) b.onclick = e => { e.preventDefault(); confirmDialog('恢复数据', '恢复会覆盖当前全部数据，确定继续？', () => { download('backup-template.json', exportJSON(), 'application/json'); toast('已生成当前备份，可编辑后导入') }, '继续') }
    else if (t.includes('立即备份')) b.onclick = e => { e.preventDefault(); download('backup-' + Date.now() + '.json', exportJSON(), 'application/json'); toast('备份已保存到下载目录') }
    else if (t.includes('清空缓存') || t.includes('清空回收站')) b.onclick = e => { e.preventDefault(); toast(t + '：已完成（本地演示）') }
    else if (t.includes('重置全部数据')) b.onclick = e => { e.preventDefault(); confirmDialog('重置全部数据', '这会清空本机保存的所有日程、待办、邮件等数据，且不可恢复。确定重置吗？<br><br>建议先「立即备份」。', () => { reset(); location.reload() }, '确认重置') }
    else if (t.includes('测试连接')) b.onclick = e => { e.preventDefault(); toast('连接测试成功（本地演示）:') }
    else if (t.includes('添加订阅源') || t.includes('添加邮箱账户') || t.includes('验证链接') || t.includes('检查更新') || t.includes('查看开源许可')) b.onclick = e => { e.preventDefault(); toast(t + '（本地演示）') }
    else if (t.includes('删除')) b.onclick = e => { e.preventDefault(); const acct = b.closest('.set-acct') || b.closest('tr'); if (acct) { acct.remove(); toast('已删除') } }
  })
  // 侧栏锚点高亮已由 CSS :target 处理
})
})()
