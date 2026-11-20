(function(){
// 统一本地数据层：所有模块共用同一份 localStorage 状态
const KEY = 'toolkit.state.v1'
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

const defaults = () => ({
  todos: [
    { id: 't1', title: '回复客户邮件', list: '工作', priority: '高', due: '今天 18:00', over: true, done: false, subs: [] },
    { id: 't2', title: '整理项目周报', list: '工作', priority: '中', due: '今天 18:30', over: false, done: false, selected: true,
      subs: [{ t: '收集本周进展', done: true }, { t: '整理成周报文档', done: false }, { t: '发送给团队', done: false }],
      note: '本周重点：项目进度同步与下周排期确认。' },
    { id: 't3', title: '取顺丰快递', list: '生活', priority: '中', due: '今天 21:00', over: false, done: false, subs: [] },
    { id: 't4', title: '阅读稍后读文章', list: '学习', priority: '中', due: '今天 22:00', over: false, done: false, subs: [] },
    { id: 't5', title: '确认会议室预订', list: '工作', priority: '低', due: '昨天 17:00', over: true, done: true, subs: [] },
    { id: 't6', title: '更新产品待办清单', list: '工作', priority: '中', due: '周五 12:00', over: false, done: false, subs: [] },
  ],
  lists: ['今天', '工作', '个人', '学习', '购物', '生活'],
  schedules: [
    { id: 's1', title: '项目周会', day: 0, start: '09:30', end: '10:30', color: 'blue', place: '会议室 A', cat: '工作', remind: '提前 10 分钟', repeat: '每周', note: '同步上周进展，确认本周排期与负责人。' },
    { id: 's2', title: '需求评审', day: 0, start: '14:00', end: '15:00', color: 'blue', place: '线上会议', cat: '工作', remind: '提前 10 分钟', repeat: '不重复', note: '' },
    { id: 's3', title: '一对一沟通', day: 2, start: '10:00', end: '11:00', color: 'blue', place: '', cat: '工作', remind: '提前 10 分钟', repeat: '不重复', note: '' },
    { id: 's4', title: '健身', day: 2, start: '19:30', end: '20:30', color: 'orange', place: '附近健身房', cat: '个人', remind: '提前 30 分钟', repeat: '每周', note: '' },
    { id: 's5', title: '周报整理', day: 4, start: '15:00', end: '16:00', color: 'green', place: '', cat: '工作', remind: '提前 10 分钟', repeat: '每周', note: '' },
    { id: 's6', title: '阅读时间', day: 5, start: '10:00', end: '12:00', color: 'orange', place: '', cat: '学习', remind: '不提醒', repeat: '不重复', note: '' },
  ],
  calendars: [{ name: '工作', color: '#2563eb', on: true }, { name: '个人', color: '#16a34a', on: true }, { name: '学习', color: '#ea580c', on: true }, { name: '节假日', color: '#94a3b8', on: true }],
  pomodoro: { focusMin: 25, shortMin: 5, longMin: 15, goal: 4, todayCount: 3, focusSeconds: 1476, task: '整理周报',
    sessions: [{ t: '整理周报', min: 25, time: '14:00-14:25', status: '完成' }, { t: '阅读文章', min: 25, time: '11:30-11:55', status: '完成' }, { t: '回复邮件', min: 12, time: '09:40-09:52', status: '中断' }] },
  cities: [{ name: '佛山', tag: '定位', temp: 24, pinned: true }, { name: '广州', tag: '常驻', temp: 25 }, { name: '深圳', tag: '常驻', temp: 26 }, { name: '北京', tag: '关注', temp: 21 }],
  weatherCity: '佛山',
  feeds: [
    { id: 'f1', src: '少数派', time: '10 分钟前', title: '本地优先软件的数据边界设计', sum: '为什么本地优先正在重新成为个人工具的核心设计原则。', read: false, star: false, later: false,
      by: '陈默', body: ['本地优先（Local-first）不是把同步关掉，而是让本机数据成为唯一权威来源，网络只作为可选增强。这样应用在没有账号、没有云端的情况下仍然完整可用。', '当用户清楚数据保存在哪里、什么时候被更新，就能对工具建立稳定的信任。缓存时间、更新时间与来源标注，都是这条边界的一部分。', '在日程、待办与阅读之间建立确定性联动，比依赖自动归类更能解决日常效率问题。'], origin: 'https://example.com/local-first-design' },
    { id: 'f2', src: '设计周刊', time: '1 小时前', title: 'RSS 阅读工作流：从收集到归档', sum: '一套可执行的订阅、稍后读与笔记联动方法。', read: false, star: false, later: false, by: '编辑部', body: ['信息流的核心不是“读完”，而是“分流”：即时阅读、稍后精读、归档留存，三类各有去处。', '把 RSS 与稍后读、笔记工具打通，才能避免收藏夹变成永远不看的垃圾堆。'], origin: 'https://example.com/rss-workflow' },
    { id: 'f3', src: '36氪', time: '2 小时前', title: '桌面效率工具的十二条交互准则', sum: '信息密度、快捷键与状态反馈的取舍。', read: false, star: false, later: false, by: '编辑部', body: ['信息密度不是越高越好，关键是把高频操作放在最短路径上。', '状态反馈要即时且可逆：每一步操作都要让用户知道发生了什么，并能撤销。'], origin: 'https://example.com/12-rules' },
    { id: 'f4', src: '阮一峰的网络日志', time: '5 小时前', title: '每周科技新闻汇总（第 218 期）', sum: '本周值得关注的开源项目与技术动态。', read: true, star: false, later: false, by: '阮一峰', body: ['本期汇总了本周值得关注的开源项目与技术动态。'], origin: 'https://example.com/weekly-218' },
    { id: 'f5', src: 'UX Collective', time: '昨天', title: 'Designing for calm in productivity tools', sum: 'How restraint and clarity beat feature creep in daily tools.', read: true, star: false, later: false, by: 'Staff', body: ['Calm tools respect attention. Restraint and clarity beat feature creep in daily tools.'], origin: 'https://example.com/calm-design' },
    { id: 'f6', src: '独立博客', time: '昨天', title: '我的离线知识管理实践', sum: '用纯文本与本地搜索构建不被平台绑架的知识库。', read: false, star: false, later: false, by: '博主', body: ['纯文本 + 本地搜索，是最可靠、最不会被平台绑架的知识库形态。'], origin: 'https://example.com/offline-km' },
  ],
  sources: [{ name: '少数派', group: '科技', on: true }, { name: '设计周刊', group: '设计', on: true }, { name: '阮一峰的网络日志', group: '独立博客', on: false }],
  parcels: [
    { id: 'p1', co: '顺丰速运', logo: 'SF', num: 'SF1234****5678', note: '双十一 · 耳机', status: '待取件', key: '取件码 8-2-104', sub: '菜鸟驿站（XX 路店）', update: '20:08',
      track: [{ b: '待取件', s: '取件码 8-2-104 · 菜鸟驿站', t: '11-19 20:06' }, { b: '派送中，快递员 138****1234', s: '佛山市禅城区', t: '11-19 14:32' }, { b: '到达佛山转运中心', s: '佛山市', t: '11-19 08:15' }, { b: '已发出，下一站佛山转运中心', s: '广州市', t: '11-18 22:40' }, { b: '已揽收', s: '广州市天河区', t: '11-18 18:20' }] },
    { id: 'p2', co: '中通快递', logo: 'ZT', num: 'ZT9876****4321', note: '生活用品', status: '在途', key: '预计明天 18:00 前', sub: '最新：已到达佛山转运中心', update: '19:36', track: [{ b: '运输中', s: '已到达佛山转运中心', t: '11-19 19:36' }, { b: '已揽收', s: '广州市', t: '11-18 20:10' }] },
    { id: 'p3', co: '京东物流', logo: 'JD', num: 'JD5566****7788', note: '键盘 · 电脑配件', status: '派送中', key: '派送中，快递员 138****1234', sub: '预计今天 21:00 前送达', update: '20:15', track: [{ b: '派送中', s: '快递员 138****1234', t: '11-19 20:15' }, { b: '到达配送站', s: '佛山市禅城区', t: '11-19 08:00' }] },
    { id: 'p4', co: '圆通速递', logo: 'YT', num: 'YT1122****3344', note: '书籍 · 3 册', status: '已签收', key: '已签收：本人签收', sub: '签收时间 11-17 15:20', update: '11-17', track: [{ b: '已签收', s: '本人签收', t: '11-17 15:20' }] },
  ],
  privacy: true,
  mails: [
    { id: 'm1', from: '张三', addr: 'zhangsan@company.com', time: '09:12', subj: '项目评审会议纪要', sum: '附件为本次评审的纪要文档，请查阅。', unread: true, star: false, important: true, tag: '工作', attach: '项目评审会议纪要.pdf', body: ['各位，附件是本次项目评审的会议纪要，重点确认了下周的排期与负责人。请查阅后于周五前反馈意见。', '如有疑问，可直接回复本邮件。谢谢！'] },
    { id: 'm2', from: '物流通知', addr: 'notice@sf.com', time: '08:40', subj: '您的快递已到达驿站', sum: '运单 SF1234****5678 已到菜鸟驿站。', unread: true, star: false, tag: '通知', body: ['您的运单 SF1234****5678 已到达菜鸟驿站，请及时取件。'] },
    { id: 'm3', from: 'HR', addr: 'hr@company.com', time: '昨天', subj: '关于年度体检安排的通知', sum: '请于本周五前确认体检时间与地点。', unread: true, star: false, important: true, tag: '工作', body: ['请于本周五前确认年度体检的时间与地点。'] },
    { id: 'm4', from: '李四', addr: 'lisi@company.com', time: '昨天', subj: '本周需求变更确认', sum: '变更清单已更新，请确认。', unread: false, star: false, tag: '工作', body: ['变更清单已更新，请查阅确认。'] },
    { id: 'm5', from: '设计周刊', addr: 'news@designweekly.io', time: '周一', subj: '本周设计灵感精选', sum: '本期收录了 8 个值得关注的界面案例。', unread: false, star: false, tag: '订阅', body: ['本期收录了 8 个值得关注的界面案例。'] },
    { id: 'm6', from: '系统通知', addr: 'system@local', time: '周一', subj: '本地备份已完成', sum: '上次备份时间 11-19 20:00（本地）。', unread: false, star: false, tag: '系统', body: ['上次备份于 11-19 20:00 完成，数据保存在本机。'] },
  ],
  notices: [
    { ico: 'clock', warn: true, title: '14:00 需求评审即将开始', sub: '日程提醒 · 13:50' },
    { ico: 'box', title: '顺丰快递已到驿站', sub: '快递状态 · 20:06' },
    { ico: 'mail', title: '工作邮箱有 2 封重要未读邮件', sub: '邮件提醒 · 19:58' },
  ],
  settings: { theme: '浅色', accent: '#0f766e', font: '小', sidebarExpand: true, desktopNotify: true,
    notify: { '天气预警': true, '日程提醒': true, '待办到期': true, '番茄结束': true, '快递状态': false, '新邮件': true },
    modules: { '仪表盘': true, '天气': true, '日程': true, '待办': true, '番茄钟': true, '信息流': true, '快递': true, '邮件': true, '数据与存储': true, '外观': true, '通知': true } },
})

let state
try { state = Object.assign(defaults(), JSON.parse(localStorage.getItem(KEY) || '{}')) }
catch (e) { state = defaults() }

const subs = new Set()
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) {}
  subs.forEach(fn => { try { fn(state) } catch (e) {} })
}
function getState() { return state }
function setState(patch) {
  if (typeof patch === 'function') patch(state)
  else Object.assign(state, patch)
  persist()
  return state
}
function subscribe(fn) { subs.add(fn); return () => subs.delete(fn) }
function reset() { state = defaults(); persist(); return state }
function exportJSON() { return JSON.stringify(state, null, 2) }
window.addEventListener('storage', e => {
  if (e.key === KEY && e.newValue) {
    try { state = Object.assign(defaults(), JSON.parse(e.newValue)); subs.forEach(fn => fn(state)) } catch (err) {}
  }
})
window.TK = { uid, getState, setState, subscribe, reset, exportJSON }
})()
