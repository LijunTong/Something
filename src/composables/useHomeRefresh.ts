// 首页刷新令牌：父页面触发、卡片监听后就地重载，避免用 :key 重挂载造成滚动位置跳动。
import { ref } from 'vue'

export const homeRefreshToken = ref(0)

export function triggerHomeRefresh() {
  homeRefreshToken.value += 1
}
