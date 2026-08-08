# Task 9：8 个共享组件迁移（web/src/components/ui/）

## 目标
将 `docs/agent-platform/prototypes/_shared/components.tsx` 的 8 个组件 **原样迁移** 为
`web/src/components/ui/`，结构 / 样式 / data-testid 保留，token 引用统一走
`web/src/theme/tokens.ts`（Task 8 完成，零改动迁移）。

## 交付文件
| 文件 | 组件 | 导出名与原型一致 | data-testid |
|------|------|------|------|
| `web/src/components/ui/agent-avatar.tsx` | AgentAvatar | ✅ | `agent-avatar` / `data-role` |
| `web/src/components/ui/agent-badge.tsx` | AgentBadge | ✅ | `agent-badge` / `data-role` |
| `web/src/components/ui/chat-bubble.tsx` | ChatBubble | ✅ | `chat-bubble` / `chat-bubble-author` |
| `web/src/components/ui/message-input.tsx` | MessageInput | ✅ | `message-input` / `message-input-mentions` / `message-input-send` |
| `web/src/components/ui/status-badge.tsx` | StatusBadge | ✅ | `status-badge` / `data-status` |
| `web/src/components/ui/sidebar.tsx` | Sidebar | ✅ | `sidebar` / `sidebar-project` / `sidebar-nav-*` |
| `web/src/components/ui/top-bar.tsx` | TopBar | ✅ | `topbar` / `topbar-user` |
| `web/src/components/ui/empty-state.tsx` | EmptyState | ✅ | `empty-state` |
| `web/src/components/ui/index.ts` | 统一出口 | 8 组件 + 类型 re-export | — |

## 原样迁移验证
逐个组件抽取原型与迁移文件中的 **组件函数体**（`export function Xxx(...)` 至 `}`）做 diff：

```
OK  agent-avatar :: AgentAvatar 组件体一致
OK  agent-badge :: AgentBadge 组件体一致
OK  chat-bubble :: ChatBubble 组件体一致
OK  message-input :: MessageInput 组件体一致
OK  status-badge :: StatusBadge 组件体一致
OK  sidebar :: Sidebar 组件体一致
OK  top-bar :: TopBar 组件体一致
OK  empty-state :: EmptyState 组件体一致
```

仅改动：`import ... from "./styles"` → `import ... from "@/src/theme/tokens"`（token 零改动迁移，
styles.ts 与 tokens.ts 逐字 diff 一致）。

## token 一致性
```
$ diff <(sed 's/^[[:space:]]*//' docs/agent-platform/prototypes/_shared/styles.ts) \
       <(sed 's/^[[:space:]]*//' web/src/theme/tokens.ts)
=== STYLES IDENTICAL ===
```
组件内未引入任何新依赖 / 新 magic number；原型字面量色值（#2563EB / #FFFFFF / #3B82F6 渐变等）
保持不变。

## Sidebar 说明（Task 5 审计继承）
原型中 Sidebar 已被 `_shared/nav.tsx` 的 NavDock 取代（0 页面使用）。按计划要求 8 组件含 Sidebar，
故 **保留导出** 并在文件头标注「历史组件，不用于导航用途；新页面请使用 NavDock / NavTopBar」，
组件体与 props 语义未改。

## 构建验证
```
$ cd web && npm run build
   ▲ Next.js 15.5.22
 ✓ Compiled successfully in 1861ms
 ✓ Linting and checking validity of types ...   ← TS 类型检查通过
 ✓ Generating static pages (5/5)
 EXIT_CODE=0
```

## 结论
- 8 组件原样迁移完成，组件体与原型 byte 级一致（仅 import 源变化）
- data-testid 全部保留
- `npm run build` 退出码 0
- 未修改 server/，未引入新依赖