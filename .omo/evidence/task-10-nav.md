# Task 10 — 导航体系迁移（Sidebar/TopBar + App Router 路由）

## 目标
将 `docs/agent-platform/prototypes/_shared/nav.tsx`（778 行）导航体系迁移为
`web/src/components/layout/`（NavDock / NavTopBar / CmdKPanel，rail 优先），
建 App Router 全局布局 `app/(main)/layout.tsx` + 8 个路由骨架 + 登录态守卫。

## 交付文件
| 文件 | 说明 |
|------|------|
| `web/src/components/layout/nav-dock.tsx` | NavDock 左缘 Dock 悬浮导航（7 项 NAV_ITEMS，hover 56→248px） |
| `web/src/components/layout/nav-top-bar.tsx` | NavTopBar 浅色顶栏（标题 + Cmd+K 触发框 + 用户头像） |
| `web/src/components/layout/cmdk-panel.tsx` | CmdKPanel 命令面板（受控开关 + Esc 关闭） |
| `web/src/components/layout/index.ts` | 统一出口 re-export 三组件 + 类型 + NAV_ITEMS |
| `web/src/components/layout/app-shell.tsx` | client 组合层：TopBar+Dock+CmdK+守卫+路径映射 |
| `web/app/(main)/layout.tsx` | 全局布局（AppShell 包裹 children） |
| `web/app/login/page.tsx` | 登录页占位（Task 11 填充） |
| `web/app/(main)/projects|board|agents|workers|skills|messages|users/page.tsx` | 7 路由占位页 |

## 迁移一致性（与原型 byte 级比对）
仅 import 源变化：`./styles` → `@/src/theme/tokens`（styles.ts 与 tokens.ts 逐字一致，
见 task-9 证据）。组件体 / CSS / data-testid / 图标 / 文案 / 选中态未改动。

- NAV_ITEMS 7 项：project▤ / board☰ / agents◉ / workers⚙ / skills◫ / messages✉ / users☷
  （对齐 06 篇 Dock 与 Cmd+K「导航」组 7 条）
- 关键样式断言（playwright getComputedStyle，与原型字面量一致）：
  - Dock：56px、radius 999、bg rgba(255,255,255,.72)、backdrop blur(14px) saturate(1.4)
  - 选中态：color #3B82F6、bg rgba(59,130,246,.12)
  - TopBar：60px、bg #FFFFFF、borderBottom 1px #E2E8F0、CmdK 触发框 280px
  - CmdKPanel：600px、radius 14、bg rgba(255,255,255,.84)、backdrop blur(20px) saturate(1.5)

## 路由骨架（HTTP 200 验证）
```
/login /projects /board /agents /workers /skills /messages /users /
→ 全部 200（next start 实测）
```

## 登录守卫验证（playwright 实测）
```
1) 未登录访问 /projects → 跳转 /login                    ✓ login-page visible
2) 已登录访问 /projects → 停留，app-shell/rail-bar/topbar 渲染 ✓
3) Dock 高亮跟随路由：project/board/agents/workers/skills/messages/users 全 7 路由 ✓
4) Ctrl+K 打开命令面板 → 选「Worker 节点」→ 跳 /workers ✓
5) 顶栏 Cmd+K 触发框打开面板 ✓；Esc 关闭 ✓
```
守卫实现：zustand persist 水合为异步 Promise 链，若在 useState 初始化时读取
hasHydrated() 会与水合完成时序竞争（onFinishHydration 已在订阅前触发则永不回调）。
改为统一在 effect 中先查 hasHydrated()、未完成则订阅 onFinishHydration 再读 token。

## 构建验证
```
$ cd web && npm run build
   ▲ Next.js 15.5.22
 ✓ Compiled successfully
 ✓ Generating static pages (13/13)
 EXIT_CODE=0
```

## 结论
- 导航体系从 nav.tsx 原样迁移完成，rail 优先（NavDock 为左缘 Dock 悬浮主导航）
- 8 路由骨架可访问，未登录访问业务页跳 /login
- 视觉与原型一致（token 零改动，截图：task10-projects / task10-dock-open / task10-cmdk / task10-login）
- 未修改 server/，未引入新依赖（仅有 zustand persist 既有 API）