# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: static HTML/CSS prototype with inline SVG icons; chosen because the user asked for a high-fidelity wireframe prototype and the workspace already contains a single-file HTML prototype.

## Users

个人效率工具使用者；在桌面端集中查看天气、日程、待办、专注、快递、信息流、邮件和通知，并把业务数据保存在本机。

## Product Purpose

提供本地优先的个人效率工具集首页仪表盘。成功标准是用户无需账户或云端服务即可在一屏内获取当天关键信息并进入对应工具。

## Positioning

无应用账户、无云同步、无 AI 能力；业务数据保存在本机。联网仅用于天气、快递、信息流和邮件收发，联网结果只做本地缓存。

## Operating Context

桌面 Web 窗口，1440px 宽；左侧固定导航、顶部搜索和快捷操作、主内容卡片网格；邮件工具需要用户配置外部邮箱，认证信息本地加密保存。

## Capabilities and Constraints

- 必须包含仪表盘、天气、日程、待办、番茄钟、信息流、快递、邮件、设置导航。
- 首页必须展示 8 类卡片：天气、今日日程、待办、番茄钟、快递、信息流、邮件、通知。
- 不出现注册、登录、云同步、AI 摘要、AI 拆解、AI 额度。
- 用户已确认：Windows 桌面窗口规范；紧凑专业的信息密度。
- 视觉约束：浅色背景、白底卡片、12px 圆角、轻阴影、蓝绿主色、橙色强调、中文界面。

## Evidence on Hand

- docs/feature-design.md：本地优先功能规划。
- prototype/index.html：已有低保真单页原型。

## Product Principles

1. 本地数据优先，界面持续显示本地存储状态。
2. 首页是今日信息的单一入口，卡片密度接近真实工具。
3. 模块松耦合但围绕任务、时间、提醒和地点联动。
4. 不引入账户体系、云端同步或 AI 能力。
