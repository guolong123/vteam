## [2026-08-06] Wave 1 完成 (Task 1-7)
- Task 1: git init 首 commit 48764b7，只含结构文件（并行脚手架不纳入）
- Task 2: web/ Next.js 15.5 + React 19.2 + TS，无 tailwind（原型内联样式机制一致），含 tanstack/zustand
- Task 3: server/ NestJS 10，全局前缀 /api/v1，health 端点，模块骨架 auth/users/projects/realtime
- Task 5: 原型审计完成。关键发现：
  - Sidebar/EmptyState 中 Sidebar 已被 nav.tsx 的 NavDock 取代（0 页面使用，勿迁移）
  - 导航用 NavDock/NavTopBar/CmdKPanel（Cmd+K 用 useState 受控）
  - Phase 1 页面依赖 AgentAvatar+StatusBadge/AgentBadge + nav 套件 + neutral/space/radius/fontSize/fontFamily/shadow token
  - login 只用 styles token 无共享组件
  - 各页有局部语义色范式（task-board 的 WAITING_STATUS 等），不扩散共享层
- Task 4: Prisma 19 model（audit_logs 预留不建）。两个规格偏离：
  - provider=["mysql","sqlite"] 数组写法 Prisma 2.22 已移除 → 用可移植类型+切换 provider 达成双库兼容
  - Prisma 5 SQLite 不支持 Json → 升级 Prisma 6.19.3
- Task 6: jest 基座（ts-jest + sqlite 测试库），test 脚本 jest --runInBand
- Task 7: 前端状态层（api.ts + authStore + QueryClientProvider）

## [2026-08-07] Wave 2/3 + F 波完成 (Task 8-22, F1-F4)
- Task 8: tokens.ts 零改动迁移（styles.ts diff 空）
- Task 9-14: 8 组件 + 导航（NavDock/NavTopBar/CmdKPanel）+ 4 页迁移（login/project-list/task-create/task-board）
- Task 15-19: AuthModule（JWT+bcrypt+refresh 扩展）、UsersModule（27 tests）、ProjectsModule（PlaceholderAuthGuard 读 x-user-id）、RealtimeModule SSE（cursor/since/heartbeat）、OpenAPI（11 端点）
- Task 20: M1 联调（next.config rewrites 代理 /api/v1 → 3000）
- Task 21: 原型一致性验收（用户自行负责最终视觉验收）
- Task 22: 全量验证（server 39/39 tests、build 全过、无 Phase 2+ 泄漏）
- F1-F4 终审全部 APPROVE（合规 5/5、质量 39/0、QA 6/6、范围 22/22）
- 关键环境事实：
  - oracle/deep subagent 不可用（oracle 报 Unknown agent），F1 用 unspecified-high、F4 用 category=deep 替代
  - 服务端口：web 3001、server 3000、原型 5177；登录 admin/admin123
  - web 3001 曾因 .next 缓存损坏返回 500，清理重启恢复
  - Prisma 6.x + 可移植类型替代 provider 数组（数组写法已移除）

## [2026-08-07] CmdKPanel 搜索修复
- cmdk-panel.tsx：搜索输入移除 readOnly，改受控 input（组件内 useState，props 契约不变，父级 app-shell 无需改动）
- 过滤逻辑：`const q = query.trim().toLowerCase()` 后对 label/group 做大小写不敏感 includes 匹配；清空恢复全部
- 过滤后再按 group 保序分组渲染；无匹配时 groups 为空 → 显示「无匹配命令」空态（neutral[400] 居中，padding 对齐 .navcmdk-item）
- 模拟光标 blink span 改为 `query.length === 0` 时渲染，输入非空时隐藏避免与真实光标双闪烁
- 环境坑：next dev（3001）与 `npm run build` 并发共享 .next 会导致 build 在 prerender 阶段报 `PageNotFoundError: Cannot find module for page`；需先停 dev server + rm -rf .next 再 build（本次用 kill 旧 next 进程树 + nohup 重启 dev 恢复）

## [2026-08-07] CmdKPanel 重开重置搜索词
- UX 缺陷：query state 常驻（面板 `if (!open) return null` 在 hooks 之后，关闭不卸载），重开面板残留上次搜索词/过滤结果
- 最小修复：新增 `useEffect(() => { if (open) setQuery(""); }, [open]);` 放在 Esc 监听 effect 旁（hooks 顺序：useState → 重置 effect → Esc effect，均在 early return 前）
- open 变 false 时 effect 不做事；变 true 时清空 query，面板每次打开展示全部 10 项命令



## [2026-08-07] NavDock 高度/圆角修复
- 触边跳闪根因：dock `top:50%; translateY(-50%)` 垂直居中，高度接近/超过宿主可用高度时胶囊圆角被宿主容器裁剪，hover 宽度动画时边缘闪烁
- 修复：dock 加 `max-height: calc(100% - 32px)`（space.xxl，上下各 16px 安全边距），dock 永不触边；纯 CSS，宿主 app-shell 已是 position:relative + height:100vh，无需改动
- 展开态舒展：收起基线 `min-height: 360px`（=7 图标内容高度，不撑高收起态）→ hover `min-height: 440px`，transition 复用 `.28s cubic-bezier(.22,1,.36,1)` 同 width 节奏
- 超高安全网：panel 改 `overflow: hidden auto`（x 裁剪保宽度动画，y 超高内部滚动）、panel-inner 加 `min-height: 0` 允许 flex 收缩；icons 加 `overflow-y: auto` 兜底（7 图标一般不触发）
- panel-inner 垂直 padding 由 16/16 增至 24/16（space.xl/lg）更舒展，token 一致
- data-testid(rail-bar/rail-icon/rail-panel/nav-item) 与组件结构零改动，build 退出码 0

## [2026-08-07] NavDock min-height/max-height 冲突修复（CSS min()）
- 根因：CSS2.1 §10.7 —— 当 min-height 计算值 > max-height 计算值，max-height 被忽略（min-height 优先）。小视口（400px 高）hover 时 min-height 440 > max-height 368，max 失效导致 dock 高 440 触边
- 修复：用 CSS `min()` 让 min-height 永不超 max-height：
  - `.navdock-dock`：`min-height: min(360px, calc(100% - 32px))`（收起基线 360，小视口自动收窄）
  - `.navdock-dock:hover`：`min-height: min(440px, calc(100% - 32px))`（展开 440，小视口自动取 368）
  - `max-height: calc(100% - 32px)` 保持封顶 + 触发面板内部滚动
- 效果：400px 视口 hover 后 dock ≈368 高、top≈16、bottom≈384 不触边；493px 视口仍 248×440；min() 目标值确定，transition 平滑
- 验证：`rm -rf .next`（历史缓存损坏问题）后 `npm run build` 退出码 0；`$?` 需在管道外取（tail 会覆盖退出码）
