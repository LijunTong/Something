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

const routes = [
  { path: '/', name: 'home', component: Home, meta: { title: '仪表盘' } },
  { path: '/weather', name: 'weather', component: Weather, meta: { title: '天气' } },
  { path: '/schedule', name: 'schedule', component: Schedule, meta: { title: '日程' } },
  { path: '/todo', name: 'todo', component: Todo, meta: { title: '待办' } },
  { path: '/pomodoro', name: 'pomodoro', component: Pomodoro, meta: { title: '番茄钟' } },
  { path: '/feed', name: 'feed', component: Feed, meta: { title: '信息流' } },
  { path: '/parcel', name: 'parcel', component: Parcel, meta: { title: '快递' } },
  { path: '/mail', name: 'mail', component: Mail, meta: { title: '邮件' } },
  { path: '/settings', name: 'settings', component: Settings, meta: { title: '设置' } }
]

export default createRouter({ history: createWebHashHistory(), routes })
