# Task 16 — Visual Overhaul：docs-site tokens 化与 markdown 富化

## 背景

用户反馈：文档站"还是很丑啊，页面没有使用markdown渲染库吗？而且不止这个问题，问题很多，总结就是全面的丑，和当前其它功能完全不搭"。

**根因**：docs-site 原实现直接用 Tailwind slate 硬编码浅色类（`text-slate-700`/`bg-slate-50`/`border-slate-200`/`bg-white`），而全应用其余 UI 走 `web/src/theme/tokens.ts` + `globals.css` CSS 变量（`--color-neutral-*`/`--color-surface`/`--color-bg`/`--color-border`），随 `.dark` class 自动反转。文档站游离在主题体系外，浅色单调、深色下更是大面积白块。

## 改动文件（7 个渲染面全部 tokens 化）

| 文件 | 改动 |
|---|---|
| `web/src/features/docs-site/docs-markdown.tsx` | 全部 slate 类 → tokens inline-style；富化 GFM：表格（table/thead/th/td + overflow-x 包裹）、代码块语言标签头、行内代码 pill、blockquote、链接（#2563EB 下划线）、strong/em/del、任务列表 checkbox、img、hr；mermaid 路径保留 |
| `web/src/features/docs-site/doc-explorer.tsx` | 三栏（左树/中内容/右章节）tokens 化；`hidden lg:flex` / `hidden lg:block` 响应式；选中态 brand 蓝；kind 徽标 |
| `web/app/(main)/docs/[taskId]/page.tsx` | 面包屑 + tab 栏 tokens 化（active tab surface 底 + shadow）；tab 图标 accent 蓝 |
| `web/src/features/docs-site/prototype-panel.tsx` | 侧栏导航 + 网格卡片 tokens 化；`md:flex-row`/`md:hidden`/`hidden md:flex`/`sm:grid-cols-2 lg:grid-cols-3` 响应式 |
| `web/src/features/docs-site/prototype-sandbox.tsx` | loading/error 态 tokens 化 |
| `web/src/features/docs-site/device-frame.tsx` | 桌面/移动框架 tokens 化；修复重复 `boxShadow` 属性 |
| `web/src/features/docs-site/device-switcher.tsx` | 切换按钮 tokens 化 |

## 关键坑：React inline style 不支持 @media

重构中曾尝试把响应式断点写入 inline `style`（如 `"@media (min-width: 1024px)"`），**浏览器静默忽略**。已全部改为 Tailwind 响应式类（`hidden lg:flex` 等），颜色仍走 tokens。涉及 9 处：doc-explorer 2、prototype-panel 6、page.tsx 1。

## 验证证据

### 1. 类型与 lint

```
$ npx tsc --noEmit -p web/tsconfig.json        → 0 错误
$ npm run lint --prefix web                     → 0 errors（727 warnings 均为既有项）
```

### 2. Docker 构建

```
$ docker compose up -d --build                  → web 镜像构建通过，五服务 running
$ curl -s http://localhost:13001/docs/t_0000000001  → 200
```

### 3. 浏览器 QA（Playwright，seed-admin 登录，任务 t_0000000001 4 文档 + 1 原型）

浅色主题（`getComputedStyle` 断言）：
- body=`#f8fafc`(neutral-50)、shell/surface=`#ffffff`、h1=`#0f172a`(neutral-900)、两侧栏=`#f8fafc`
- 面包屑/active tab=`#ffffff`(surface) + shadow
- h2=`#0f172a`(neutral-900)、thead=`#f8fafc`(neutral-50)、th/td=`#334155`(neutral-700)、表格边框=`#e2e8f0`(neutral-200)、li=`#334155`(neutral-700)
- 三栏布局 2560px：左 aside `flex`、右 aside `block`（lg 断点生效）

深色主题（手动 `root.classList.add('dark')` 后断言）：
- body=`#020617`、shell/surface=`#1e293b`、h1=`#f8fafc`、两侧栏=`#0f172a`、面包屑/tab=`#1e293b`
- h2=`#f8fafc`(neutral-50)、thead=`#0f172a`(neutral-900)、th/td=`#e2e8f0`(neutral-200)、表格边框=`#334155`(neutral-700)、li=`#e2e8f0`(neutral-200)
- 原型面板：aside=`#0f172a`、main=surface、iframe `proto-frame` 渲染、sticky 头跟随主题；网格区因仅 1 原型正确隐藏（`>1` 才显示）

### 4. testid 契约（grep 确认保留）

`docs-shell`、`docs-back-to-task`、`docs-task-title`、`docs-tab-bar`、`docs-tab-docs`、`docs-tab-protos`、`docs-explorer`、`docs-prototype-panel`、`docs-mermaid`、`docs-mermaid-fallback`、`docs-mermaid-loading`、`proto-frame`、`proto-error` 全部在重写后保留。

## 结论

APPROVE — 双主题跟随全应用 tokens、markdown 富化（表格/代码块/引用等）、布局响应式、testid 契约完整、类型/lint/构建/浏览器 QA 全绿。
