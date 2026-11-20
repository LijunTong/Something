// 首页卡片的显隐统一收口：首页卡片菜单、卡片设置面板、首页渲染都读同一份 modules 设置。
import { computed } from 'vue'
import { useSettings } from '@/composables/useSettings'
import type { ModulesSetting } from '@/types/api'

export const CARD_KEYS = ['weather', 'schedule', 'todo', 'pomodoro', 'feed', 'parcel', 'mail', 'notice'] as const
export type CardKey = (typeof CARD_KEYS)[number]

export const CARD_META: Record<CardKey, { label: string; hint: string }> = {
  weather: { label: '天气', hint: '当前温度、体感、湿度与风向' },
  schedule: { label: '今日日程', hint: '今天的时间轴、地点与提醒' },
  todo: { label: '今日待办', hint: '勾选、优先级与逾期统计' },
  pomodoro: { label: '番茄钟', hint: '计时、绑定任务与今日番茄' },
  feed: { label: '信息流', hint: '未读文章与稍后读' },
  parcel: { label: '快递', hint: '在途、待取件与取件码' },
  mail: { label: '邮件', hint: '未读、重要标记与同步时间' },
  notice: { label: '今日通知', hint: '日程/待办/快递/邮件的规则汇总' }
}

export function useHomeCards() {
  const { settings, save } = useSettings()

  const modules = computed<ModulesSetting>(() => settings.value.modules)

  /** 未设置过视为显示，避免老数据里缺字段导致卡片消失 */
  function shown(key: CardKey): boolean {
    return modules.value[key] !== false
  }

  async function setVisible(key: CardKey, visible: boolean) {
    await save('modules', { ...modules.value, [key]: visible })
  }

  const hiddenCount = computed(() => CARD_KEYS.filter((k) => !shown(k)).length)

  return { shown, setVisible, modules, hiddenCount }
}
