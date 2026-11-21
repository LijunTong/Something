// 首页刷新令牌：父页面或单张卡片的菜单触发、卡片监听后就地重载，避免用 :key 重挂载造成滚动位置跳动。
import { computed, ref, type ComputedRef } from 'vue'
import type { CardKey } from '@/composables/useHomeCards'

/** 全量刷新：首页顶部「刷新」按钮与模块写库广播走这里 */
export const homeRefreshToken = ref(0)

/** 单卡片刷新：卡片菜单里的「刷新」只动这一张，其余卡片不重排、不闪 */
const cardTokens = ref<Partial<Record<CardKey, number>>>({})

export function triggerHomeRefresh(module?: CardKey) {
  if (!module) {
    homeRefreshToken.value += 1
    return
  }
  cardTokens.value = { ...cardTokens.value, [module]: (cardTokens.value[module] || 0) + 1 }
}

/** 卡片侧订阅：全量令牌或自己的单卡令牌任一变化都会触发 */
export function useHomeCardRefresh(module: CardKey): ComputedRef<number> {
  return computed(() => homeRefreshToken.value + (cardTokens.value[module] || 0))
}
