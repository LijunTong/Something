import { createRouter, createWebHashHistory } from 'vue-router'
import Home from '@/views/Home.vue'
import Todo from '@/views/Todo.vue'
import Schedule from '@/views/Schedule.vue'
import Pomodoro from '@/views/Pomodoro.vue'
import Weather from '@/views/Weather.vue'
import Feed from '@/views/Feed.vue'
import Parcel from '@/views/Parcel.vue'
import Mail from '@/views/Mail.vue'
import Settings from '@/views/Settings.vue'
import Notice from '@/views/Notice.vue'
import Widget from '@/views/Widget.vue'

const routes = [
  { path: '/', name: 'home', component: Home, meta: { title: '仪表盘' } },
  { path: '/weather', name: 'weather', component: Weather, meta: { title: '天气' } },
  { path: '/schedule', name: 'schedule', component: Schedule, meta: { title: '日程' } },
  { path: '/todo', name: 'todo', component: Todo, meta: { title: '待办' } },
  { path: '/pomodoro', name: 'pomodoro', component: Pomodoro, meta: { title: '番茄钟' } },
  { path: '/feed', name: 'feed', component: Feed, meta: { title: '信息流' } },
  { path: '/parcel', name: 'parcel', component: Parcel, meta: { title: '快递' } },
  { path: '/mail', name: 'mail', component: Mail, meta: { title: '邮件' } },
  { path: '/notice', name: 'notice', component: Notice, meta: { title: '通知' } },
  { path: '/settings', name: 'settings', component: Settings, meta: { title: '设置' } },
  // 桌面挂件窗口：独立 BrowserWindow 载入同一个 dist，靠 hash 进这条路由（见 electron/widget.cjs）
  { path: '/widget/:card', name: 'widget', component: Widget, meta: { title: '桌面挂件' } }
]

export default createRouter({ history: createWebHashHistory(), routes })
