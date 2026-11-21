// 通知提示音：音频资源在仓库根的 assets/sounds，Vite 编译成哈希地址，
// 渲染层用 HTMLAudio 播放；Windows 的 toast 不支持自定义音频，所以系统通知也用这条通道。
import bee from '../../assets/sounds/蜂鸣.mp3'
import info1 from '../../assets/sounds/信息提示音1.mp3'
import info2 from '../../assets/sounds/信息提示音2.mp3'
import info3 from '../../assets/sounds/信息提示音3.mp3'
import odn from '../../assets/sounds/Odnoklassniki.mp3'

/** 默认提示音 */
export const DEFAULT_SOUND = '蜂鸣'

export const SOUND_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '蜂鸣（默认）', value: '蜂鸣' },
  { label: '信息提示音 1', value: '信息提示音1' },
  { label: '信息提示音 2', value: '信息提示音2' },
  { label: '信息提示音 3', value: '信息提示音3' },
  { label: 'Odnoklassniki', value: 'Odnoklassniki' }
]

const FILES: Record<string, string> = {
  '蜂鸣': bee,
  '信息提示音1': info1,
  '信息提示音2': info2,
  '信息提示音3': info3,
  'Odnoklassniki': odn
}

/** 播放提示音；名字不认识时回退蜂鸣，播放失败静默（没声总比抛错好） */
export function playNotifySound(name?: string): void {
  const src = FILES[String(name || '')] || FILES[DEFAULT_SOUND]
  if (!src) return
  try {
    const audio = new Audio(src)
    audio.volume = 0.6
    void audio.play().catch(() => { /* 自动播放策略或设备缺失时忽略 */ })
  } catch (e) { /* 同上 */ }
}
