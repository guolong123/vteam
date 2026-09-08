# Smell Report: vteam web（AI 协作平台）

**Score:** 8/10 · FAINT
**Date:** 2026-09-08
**Scope:** `web/app/login/page.tsx`、`web/app/(main)/teams/page.tsx`、`web/src/components/auth/BrandPanel.tsx`、`web/src/components/layout/nav-dock.tsx`、`web/src/theme/tokens.ts`、`web/app/globals.css`

## TL;DR

骨架是有人做过决定的：中文字体栈（PingFang/HarmonyOS/微软雅黑 + Sora 展示字）是刻意的，动效是收敛的 ease-out、无弹性 bounce，登录页分栏是正确的 Configure 形态。真正的味道只有两处，且都聚在颜色上：Logo 两处蓝→紫渐变（tech gradient），以及全站 30+ 处无差别的通用科技蓝（generic tech hue）。另有一个伴随的 HIGH：共享输入样式 `outline: none` 且无 `:focus-visible` 替代，键盘用户看不见焦点。

## Heuristic scores

| # | Heuristic | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | tech gradient | 0 | `BrandPanel.tsx:89`、`nav-dock.tsx:173`，Logo 蓝→紫渐变 |
| 2 | generic tech hue | 0 | `#2563EB` / `#3B82F6` 遍布按钮/链接/选中态，无域内理由 |
| 3 | feature tile grid | 1 | absent：团队卡片是操作对象（各有成员/队列/当前任务），非营销特性瓦片 |
| 4 | accent rail | 1 | absent |
| 5 | unearned blur | 1 | absent：Dock 悬浮于内容之上且有 shadow 体系，blur 有分离作用 |
| 6 | stat monument | 1 | absent：未见数字纪念碑 |
| 7 | icon topper | 1 | absent：Dock 图标是功能导航，空态 ◉ 是单字形而非模板 icon topper |
| 8 | bounce everywhere | 1 | absent：过渡均为 ease / cubic-bezier(.22,1,.36,1)，无弹性 easing |
| 9 | default type | 1 | absent：CJK 系统栈 + Sora 展示字 + JetBrains Mono，有理由的选择 |
| 10 | center stack | 1 | absent：登录表单居中是 Configure 正确形态，teams 页左对齐 + 网格 |

2 tells → 8/10 · FAINT。

## Findings

| # | Severity | Discipline | Location | Before | After | Why |
|---|----------|------------|----------|--------|-------|-----|
| 1 | HIGH | Accessibility | `web/src/components/auth/BrandPanel.tsx:259`（`authInputStyle`，登录/注册共用；全站约 40 处同类 `outline: none`） | `outline: "none"`，无 `:focus-visible` 替代 | `globals.css` 加全局 `:focus-visible` 焦点环（本轮已加）；剩余内联 `outline: none` 由 `/design a11y` 逐个清理 | Tab 可落、无可见指示，severity Escalation Trigger，永不平均掉 |
| 2 | MEDIUM | Color | `web/src/components/auth/BrandPanel.tsx:89`、`web/src/components/layout/nav-dock.tsx:173` | `linear-gradient(135deg,#3B82F6,#8B5CF6)` Logo 渐变 | 实色品牌 mark `#2563EB`（本轮已改） | 蓝→紫渐变即 tech gradient，在登录页与导航两处重复形成系统信号 |
| 3 | MEDIUM | Color | 全站主按钮/链接/选中态（`#2563EB` 约 30+ 处，见 Verification） | 通用科技蓝，无域内理由 | `/design recolor`：选一个与"AI 团队协作"绑定的 hue，按 OKLCH 建角色 | 配色可从行业直接猜中（domain default trap），换渐变不换 hue 只去了一半味道 |

## Considered but rejected

| Location | Candidate | Rejected because |
|----------|-----------|------------------|
| `web/app/(main)/teams/page.tsx:269` | 卡片网格判为 feature tile grid | 每张卡是不同团队的操作对象（成员/队列/当前任务各异），属 Operate 正确形态 |
| `web/app/login/page.tsx:605-617` | 表单卡片居中判为 center stack | 登录是 Configure 模式，表单居中是正确 lane，不是没做构图决定 |
| `web/src/components/layout/nav-dock.tsx:88-89` | Dock 毛玻璃判为 unearned blur | Dock 悬浮于内容之上且有 shadow sm/md/lg 体系，blur 起分离作用，有其位置 |
| `web/src/theme/tokens.ts:97-101` | 字体判为 default type | CJK 系统栈 + Sora 展示字是针对中文产品的刻意选择，不是没选 |
| `web/app/(main)/teams/page.tsx:202-211` | 搜索框 placeholder-only | 有 `aria-label="搜索团队"` + 搜索图标，名称可被读出，不触发 escalation |

## Verification

已运行：

- 读文件：`login/page.tsx`（624 行）、`teams/page.tsx`（281 行）、`BrandPanel.tsx`（283 行）、`nav-dock.tsx`（297 行）、`tokens.ts`、`globals.css` —— 确认渐变 2 处、共享 `outline: none`、字体栈与动效曲线。
- `grep "indigo|#6366F1|from-indigo|...|Inter"` 全 web —— 未命中 `#6366F1`/indigo/Inter；命中均为 WebGL 变量名与 `IntersectionObserver`，属误报排除。
- `grep "outline"` 全 web —— 约 40 处 `outline: none`（issues/users/models/agents/teams 等页 + 共享组件），确认为系统性。
- `curl localhost:13001` → `200`，首页为登录守卫重定向壳（client-side redirect），确认 13001 = compose 内 web 生产构建。

**Not verified**：渲染后像素 diff（容器跑的是旧构建，本轮改动需 `docker compose up -d --build web` 后再看）、色盲模拟（deuteranopia/protanopia/tritanopia）、键盘全程走查。以上缺口未转为 finding，也未默许通过。

## Verdict

**Block** —— HIGH（#1 焦点环）仍在走查清理中；颜色两处本轮已处理。

## Next modes

`/design a11y`（清理 40 处内联 `outline: none`、补键盘路径）→ `/design recolor`（品牌 hue 承诺 + OKLCH 角色）。
