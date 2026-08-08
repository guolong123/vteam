# Task 14：task-board 页迁移证据

## 结论

`docs/agent-platform/prototypes/task-board/index.tsx` 已保真迁移为
`web/app/(main)/board/page.tsx`。`npm run build` 退出码 0，Playwright 实测
DOM 结构与点击交互全部通过。

## 关键决策：布局形态

任务描述称「看板五列」，但**原型唯一来源**
`docs/agent-platform/prototypes/task-board/index.tsx` 的实际布局是：

- **状态筛选条**（pills：全部 / 待开始 / 进行中 / 待验收 / 已完成 / 已归档，FR-03 五态 +
  「全部」）+ **任务卡片网格**（`gridTemplateColumns: repeat(auto-fill, minmax(300px, 1fr))`）
- 无列头、无按状态分列、无拖拽实现（拖拽形态仅表现在卡片 hover shadow 过渡）

按 MUST DO「先 Read 原型，保真迁移」与「唯一来源：原型 index.tsx」要求，以原型
代码为准迁移（「五列」为任务作者对五态布局的概括）。筛选为静态（默认「全部」激活，
无点击逻辑），与原型一致。

## 迁移映射

| 原型 | web 迁移 |
|------|----------|
| `_shared/styles.ts` tokens | `@/src/theme/tokens.ts`（型对齐，值一致） |
| `_shared/components` AgentAvatar / StatusBadge | `@/src/components/ui` 共享组件 |
| `_shared/nav` NavTopBar / NavDock / CmdKPanel | 由 `(main)/layout.tsx` AppShell 提供，本页不渲染 |
| NAVDock children 任务统计面板 | 未迁移：AppShell NavDock 无 children 插槽，记录留待 Phase 2 |
| WAITING_STATUS 灰蓝 #475569 系 + WaitingBadge | 页面内本地定义（Task 5 审计铁律：不扩散共享层） |
| `useState` CmdK 开关 | 由 AppShell 管理（cmdk-open），本页不持有 |
| `useState` start-task hintOpen | 保留在 TaskCard（点击展开/收起「开始前检查」） |

## 保真保留

- data-testid：`task-board-root` / `status-filter` / `status-filter-option` /
  `task-card` / `task-members` / `task-artifact-count` / `start-task-button` /
  `start-task-hint` / `status-badge(data-status)`（rail-bar / topbar / cmdk-trigger
  / cmdk-panel 由 AppShell 提供）
- 卡片结构：编号(mono) + 状态徽章 / 标题 + 2 行截断描述 / 头像组（负 margin 叠放）+
  产出物数量 / 待开始卡片「开始任务」按钮
- Seed 数据 5 任务覆盖五态（T-1044 待开始 / T-1043 进行中 / T-1042 待验收 /
  T-1041 已完成 / T-1012 已归档），12 个头像 = 3+2+4+2+1
- 铁律（T15）：无 fixed / 100vh / 100vw；本页无浮层，高度由 AppShell main
  （flex column + overflow auto）接管

## 验证

### 1. 构建（隔离目录，退出码 0）

原 `.next` 目录被遗留 `next-server`（端口 3111、后又被并发会话 `next dev -p 3001`
重启）持续抢占，`npm run build` 在 trace 收集阶段间歇性 ENOENT。已杀掉遗留
next-server（3111，渲染旧占位页的空转进程），并在隔离目录
`/tmp/opencode/web-build`（软链 node_modules）完成生产构建验证：

```
BUILD_EXIT=0
✓ Compiled successfully in 2.6s
✓ Generating static pages (14/14)
├ ○ /board   2.43 kB   106 kB
```

### 2. Playwright 实测（headless chromium，注入 authStore token 过登录守卫）

隔离 prod server `next start -p 3210`，访问 /board：

| 断言 | 结果 |
|------|------|
| task-card 数量 | 5 ✓（data-task-id T-1012/1041/1042/1043/1044） |
| status-filter-option 数量 | 6 ✓（全部+五态，data-key 正确） |
| status-badge 数量 | 5 ✓（data-status 五态各一，"待开始"为本地 WaitingBadge） |
| task-members / task-artifact-count | 5 / 5 ✓ |
| start-task-button | 1 ✓（仅待开始卡片） |
| start-task-hint 初始 | 0 ✓ |
| 点击「开始任务」后 hint | 1 ✓（展开「开始前检查」） |
| 再次点击后 hint | 0 ✓（收起，交互骨架与原型一致） |

截图：`task-14-board.png`（1440×900 full page）。

## 说明

- `login/page.tsx` 存在预先存在的 TS2783 错误（flexDirection 重复指定），不在本次
  改动范围（TSC 报错文件，build 因 Next 增量类型检查通过）。
- 未引入 dnd 依赖；未改动 server/；未改看板布局与共享层。