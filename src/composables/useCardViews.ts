import type { Component } from 'vue'
import WeatherCard from '@/components/home/WeatherCard.vue'
import ScheduleCard from '@/components/home/ScheduleCard.vue'
import TodoCard from '@/components/home/TodoCard.vue'
import PomodoroCard from '@/components/home/PomodoroCard.vue'
import ParcelCard from '@/components/home/ParcelCard.vue'
import FeedCard from '@/components/home/FeedCard.vue'
import MailCard from '@/components/home/MailCard.vue'
import NoticeCard from '@/components/home/NoticeCard.vue'
import type { CardKey } from '@/composables/useHomeCards'

/**
 * 卡片组件映射：首页网格与桌面挂件共用同一份。
 * 挂件窗口也会渲染同一批卡片组件，两处各写一遍映射迟早会漏改（新增卡片只加了一边）。
 */
export const CARD_VIEWS: Record<CardKey, Component> = {
  weather: WeatherCard,
  schedule: ScheduleCard,
  todo: TodoCard,
  pomodoro: PomodoroCard,
  parcel: ParcelCard,
  feed: FeedCard,
  mail: MailCard,
  notice: NoticeCard
}

/** 模板里 LayoutItem.i / 路由参数的类型是 string | number，取值统一在这里收敛成 CardKey */
export function cardView(key: string | number): Component {
  return CARD_VIEWS[key as CardKey]
}

export function isCardKey(value: unknown): value is CardKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CARD_VIEWS, value)
}
