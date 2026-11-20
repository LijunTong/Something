# Design

## Surface: 首页仪表盘

- Mode: Operate
- Platform: web / desktop window
- User-confirmed: Windows 桌面窗口规范；紧凑专业信息密度。
- Visual world: Local Utility Precision — cool neutral canvas, dense modular cards, teal as trusted system color, orange reserved for reminders and exceptions.
- Palette: canvas #f3f6f8, surface #ffffff, text #17252a, muted #64757d, line #dfe7e9, primary #0f766e, primary-soft #e6f4f1, accent #d97706, accent-soft #fff3e4.
- Type: Microsoft YaHei 优先（Windows），回退 PingFang SC / 系统无衬线；正文 14px、辅助 12–13px、页面标题 21px、卡片标题 16px；字号三档 小 13 / 中 14 / 大 15，令牌与主题同源缩放。
- Shape: 12px cards, 8px controls, 999px pills; one subtle shadow level.
- Layout: 248px sidebar + topbar + scrollable content grid; 1440px 下三列，1100px 下两列。
- Signature: 状态以细节承担语义——蓝绿色表示本地/正常/进行，橙色只表示提醒、待取件和异常；所有图标为线性 SVG。
- Non-goals: 注册登录、云同步、AI 摘要/拆解/额度、营销语、装饰性渐变。

## Direction contract

THESIS: 一屏完成今日状态判读；不是营销式作品集仪表盘，而是可操作的本地效率控制台。
OWN-WORLD: 冷灰蓝底、白色模块卡、蓝绿系统与橙色例外；细线分隔、清晰状态点、线性图标。
STORY: 用户先确认本地存储状态和待处理提醒，再按卡片进入日程、待办、专注和邮件；所有数据看起来都由本机管理。
FIRST VIEWPORT: 248px 侧栏；顶栏搜索、快捷添加、通知、本地状态；主区标题下 3 列卡片网格，日程与邮件为宽卡，天气/待办/番茄/快递/信息流/通知为标准卡。
FORM: code-led；参照 Windows 11 桌面应用密度与结构；seed: none (pinned)。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
