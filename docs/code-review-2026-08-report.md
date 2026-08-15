# vteam 代码审核报告（死代码与 AB 双实现残留）

- **审核范围**：`server/`（NestJS + Prisma）、`web/`（Next.js）、`worker/`（Node opencode 执行节点）
- **分支**：`feature/git-repo-credentials`（含未提交工作区改动）
- **审核方式**：只读；逐一手工核验引用关系（grep 交叉引用 + 源码阅读）+ 并行子 agent 全量交叉扫描
- **结论预览**：无严重安全漏洞；`shell` 型双实现残留（Phase 2 mock → Phase 4 真实实现的旧文件未删）是本次重点，共确认 **5 处 A 类死代码**（server 3 处 + web/worker 2 处）、若干 B 类双实现并存与 C 类存疑/多余设计。

---

## 一、背景：项目的 AB 双实现演进

本项目经历了「Phase 2 mock 模拟 → Phase 4 worker 真实实现」的演进（对应设计文档 `docs/agent-platform/18-推进计划（分阶段实施）.md`、`.omo/plans/phase4-worker-opencode.md`）。演进过程中部分旧实现文件按「F4 零污染基线」保留未删，形成了**新旧并存、产线只走一条**的 AB 残留模式。

> 判定准则：某符号/文件**只有自身的 spec 测试引用、无任何生产 import / provider 接线 / controller 路由**时，视为死代码（spec 会带来"错误存活感"）。

---

## 二、A 类 — 确认死代码（无生产引用，可删）

### A1. `server/src/chat/mock-dispatcher.ts`（`MockDispatcher`）

- **真实实现**：`chat.module.ts:36` `{ provide: MessageDispatcher, useExisting: WorkerDispatcher }` —— `WorkerDispatcher` 是唯一活分派器。
- **证据**：全库 grep 中 `MockDispatcher`/`mock-dispatcher` 只出现在**注释**里（`message-dispatcher.ts:4`、`worker-dispatcher.ts:569/574/578/843/971`、`chat.module.ts:19`、`chat.service.ts:342`），作为"对齐/replyFor 参考"。零 provider 接线、零 `@Inject`、零 `new MockDispatcher()`。
- **判定**：Phase 2 mock 分派器被 `WorkerDispatcher` 完全取代，文件保留仅为注释基线，**产线死代码**。
- **建议**：删除 `mock-dispatcher.ts` 及其 `mock-dispatcher.spec.ts`；将 `worker-dispatcher.ts` 内对 `MockDispatcher` 编号的注释改为描述文字，避免悬挂引用。

### A2. `server/src/artifacts/artifacts-mock-consumer.ts`（`ArtifactsMockConsumer`）

- **证据**：`artifacts.module.ts:21` 将其注册为 provider 并 `exports`（:22），但其唯一公开方法 `simulateSubmission`（:58）**无任何非 spec 生产调用点**（`artifacts.controller.ts` 无对应路由；仅 spec 与注释提及）。
- **判定**：**已接线但运行时永不执行** —— 模拟 Phase 4 worker 归档回流的工具，被真实 `worker-dispatcher` / `platform-mcp` 归档链路取代后残留，属多余的生产 wiring。
- **建议**：删除 `ArtifactsMockConsumer`，并从 `artifacts.module.ts` 的 `providers` / `exports` 摘除其注册。

### A3. `worker/src/git/git-credentials.ts`（`resolveGitEnv / createTempKey / cleanup`）

- **证据**：全库生产代码**零 import**（仅 `git-credentials.spec.ts:10` 引用）。文件头注释自述"本任务只提供能力 + 单测，实际注入由 T3/T4 集成"，原注"https token 留待下轮" —— 属未完成的占位脚手架。
- **真实路径**：凭据注入走 `git-credential-injector.ts`（`.keta-git-creds.json` 文件式落盘）；且 `git-tools.ts` 把同款临时 key / askpass 辅助函数**内联复刻**进渲染产物（`writeTempKey` / `writeAskpass` / `cleanupTemp`）。
- **删除影响（已核验）**：`git-tools.ts` 与全库无一处 import `git-credentials.ts` 的导出；`model-credential-injector.ts:58/73` 仅**注释**提到"仿 git-credentials.ts"。删除（含 `git-credentials.spec.ts`）**零生产副作用**，可安全删。
- **建议**：删除 `git-credentials.ts` 及其 spec。若需保留单测语义，可将用例迁移到 `git-credential-injector.spec.ts` 或 `git-tools.spec.ts`。

> 说明：以上三处同型，均为「mock / 占位 → 真实实现」遗漏清理。删除时建议同步检查是否仍被 `tsconfig.build / jest` 的 include 引用（通常无碍）。

### A4. `web/src/components/ui/sidebar.tsx`（`Sidebar`）与 `ui/top-bar.tsx`（`TopBar`）

- **证据**：全项目 grep 中二者只有自身文件 + `ui/index.ts` barrel 导出引用（`ui/index.ts:25/27`），**0 页面使用**。`sidebar.tsx` 头注释自述"原型中 Sidebar 已被 _shared/nav.tsx 的 NavDock 取代（0 页面使用）；此处作为历史组件保留导出，不用于导航用途；新页面请使用 NavDock / NavTopBar"。
- **判定**：历史导航组件，被 `layout/nav-dock.tsx` + `nav-top-bar.tsx`（经 `app-shell.tsx` 实渲染）取代后仅靠 barrel 保活，**孤儿组件（死代码）**。
- **关联清理**：主题 token `src/theme/tokens.ts` 的 `sidebarTheme`（:98）仅被 `sidebar.tsx` 使用（:51/52/64 等），随 A1 一并清理。

### A5. `worker/src/git/git-op-reporter.ts`（`GitOpReporter` / `extractGitOps`）

- **证据**：`GitOpReporter`/`extractGitOps` 生产代码**零 import**（仅自身/`git-op-reporter.spec.ts` 引用）。文件头注释自述 git.op 审计上报设计，**挂载点标注"awaitCompletion 的 onPoll 回调"但该处实际未接线**——`exec-server.ts:567` 的 `onPoll` 只做 delta 增量上送，未调用 reporter。
- **跨端连带**：worker 侧 `WORKER_EVENT_TYPES.GIT_OP`（`worker-protocol.ts:21`）仅被死 `git-op-reporter.ts` 引用，**无活跃生产者**；而 **server 侧 `worker-event.ingress.ts:301/679` 已完整实现 `git.op` 消费并落库 `task_events`**。即「消费者已接线、生产者从未接线」——整条 git.op 审计功能跨端未打通，server 消费逻辑处于休眠状态（非死代码，但收不到事件）。
- **判定**：**设计/规划但从未接线的整文件死代码**（T6 git.op 上报功能未完成实现，属"多余设计"残留）。
- **建议**：若短期内不实现 git.op 上报，删除 `git-op-reporter.ts` 及其 spec（`git.op` 常量与 server 消费逻辑保留，作为半成品功能标注）；实现时按注释重新接线到 `onPoll`。

---

## 三、B 类 — AB 双实现 / 新旧并存残留（产线只走新路径，旧路径保存未删）

### B1. `web/` 导航双轨：`ui/sidebar.tsx` + `ui/top-bar.tsx`（旧）vs `layout/nav-dock.tsx` + `layout/nav-top-bar.tsx`（新）
- 新路径经 `app-shell.tsx` / `app/(main)/layout.tsx` 实渲染并全页面使用；旧条仅靠 `ui/index.ts` barrel 导出保活，0 页面使用（即 A4）。
- **判定**：AB 并存，旧条为历史导航组件，产线从不渲染。

### B2. `worker/` git 凭据双轨：`git/git-credentials.ts`（旧 GIT_SSH_COMMAND，死）vs `git/git-credential-injector.ts`（活）
- 活路径为 `.keta-git-creds.json` 文件式落盘；旧 `git-credentials.ts` 无生产引用（即 A3）。已核验 git / model-credential / custom-tool 三路注入其余均为活接线，无其它死分支；`v1-driver` 为唯一活驱动。

### B3. `server/` mock → 真实 双轨
- `chat/mock-dispatcher.ts`（旧，A1）被 `worker-dispatcher.ts`（Phase 4 真实分派）取代；`artifacts/artifacts-mock-consumer.ts`（A2）仍被 `artifacts.module.ts:5` import（存活但运行时无调用）。`chat.module.ts:19` 明注"原 MockDispatcher 保留不动"。

> B 类与 A 类是同一批残留的两面：A 类给出待删对象，B 类说明其"并行存在的旧方案"关系，便于按演进史核对。

---

## 四、C 类 — 存疑 / 多余设计（需人工确认后决定去留）

### C1. `web/src/components/canvasui/*`（Liquid / VHS / Glitch / Asciify / Cloth / HexFloat / Droplets / Bubble / Canvas / global）

- **证据**：整套视觉特效组件由 `app-shell.tsx` 经 `canvasui/store` 引用，效果由 `localStorage["canvasui.demo-mode"]` 开关控制（`app-shell.tsx:31/248`），e2e 含 `data-testid="canvasui-select"`。经 `global.tsx` `next/dynamic import()` 全被 `app/layout.tsx:20` 的 `CanvasUIGlobal` 动态渲染。
- **判定**：**非严格死代码**（demo/FX 模式下可触发、随包带入），但属**演示性 FX 残留**（默认隐藏，`?fx=on` 才显示）。是否保留需产品侧拍板；若为展示用途不应随生产包发布，建议按需动态加载或剔除。

### C2. `worker/src/client/event-client.ts` 的 `resetEventSeq` / `getEventBootId`（测试辅助导出）
- 生产代码 0 引用，仅 `event-client.spec.ts` 使用；文件注释标注"测试辅助，生产无需调用"。
- **判定**：spec 需要，非死代码；如需 strict 可保留（导出来源仅为测试，属轻微"测试专用导出"）。

### C3. 仓库根目录未跟踪的调试快照 + 运行时目录

- 根目录散落未跟踪文件：`bug1-question-modal.png`、`dock-*.png`、`qa-board.png`、`login-snapshot.yml`、`skills-login-snapshot.yml`、`mcp-*.png` 等（验证/截图残留）。
- `server/uploads/`（产出物运行时落盘目录）未纳入 `.gitignore`。
- **建议**：截图移入 `.omo/evidence/` 或纳入 ignore；`server/uploads/` 加入 `.gitignore`。

### C4. `web/app/page.tsx`（根路由占位脚手架）
- 头注释标注为脚手架占位页（“业务页面见计划任务 …”），无守卫、无跳转，实际访问不到，属遗留占位。`app/(main)/providers/page.tsx` 为显式 `/providers → /models` redirect（URL 直达兼容）——已核实不在导航表 / 无 `router.push('/providers')`，仅兼容入口。
- **判定**：`/` 占位页属遗留，建议改为 `redirect('/projects')` 或删除；`/providers` 兼容重定向若接受旧 URL 失效也可删。

---

## 五、排除误报（已核验为活代码，勿删）

| 文件 / 符号 | 为何是活代码 |
|---|---|
| `server/src/chat/message-dispatcher.ts`（`MessageDispatcher`） | 抽象基类，`WorkerDispatcher` 继承之，且为 DI token（`chat.module.ts` `useExisting`） |
| `server/src/common/id-resync.ts`（`resyncIdPrefix`） | 被 agents/models/tools/issues/skills/git-repos/session-lifecycle/questions 等多处 service 引用 |
| `server/src/common/credential-crypto.service.ts` | 被 models/git-repos/workers 等 module 引用 |
| `server/src/skills/skill-frontmatter.util.ts` | 被 skills.controller / skills.service 引用 |
| `web/src/components/chat/question-modal.tsx` | 已接入 `tasks/[id]` 与 `messages/[id]` 两页 |
| `worker/src/driver/v1-driver.ts` | 唯一活驱动（“v1”是版本名，非新旧并存） |
| `server/src/common/constants/*.ts` | 常量大多被各 service 消费 |

---

## 六、注意事项

- 本次为**代码结构/死代码**视角；完整的功能与安全审核（如 worker `/execute` 无鉴权、`read_file` 路径不受限、默认 `dev-worker-token`、`question-modal.tsx` answers 错乱、`artifacts.append` 落盘竞态等【严重/重要】项）不在本文范围，需另建全面审核文档或见对话审核汇总。
- 删除死代码前建议在特性分支执行，并跑通 `server` / `worker` 的 `tsc --noEmit` 与单测，确认无悬空引用。

---

*文档生成时间：2026-08 · 审核者为代码分析流程（仅只读，未改动源文件）。*
