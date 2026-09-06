# vteam-agent-strengthening - Work Plan
## TL;DR (For humans)
**What you'll get**: 计划提交质量门槛（acceptance/qa 必填 + QA 可执行性自动打回）+ 评审 Momus 四项清单（不再走过场）+ 驳回 3 次上限 + 以服务端为唯一规则源的 ExecutionPolicy 执行策略体系（策略与角色解耦、可页面管理、通过协议下发给 worker 盲翻成 opencode 配置，单通道实现）。

**Why this approach**: 对齐 omo 三层约束哲学但适配 vteam 分布式约束：规则只在 server 产生与存储（零 worker 业务知识），worker 只做通用翻译（ExecutionConfig → opencode 形态）。计划侧先做纯 server 改动（B 线），与 A 线单通道验证并行，风险可控。零兼容负担故以 policyId 为唯一权限来源，不做双轨兜底。

**What it will NOT do**: 不兼容存量 `permissionScope` 内嵌机制（直接退役）；A 线不做主备双通道，A1 验证后选定唯一通道落地；不改动用户已自定义 agent 的 prompt 文本；不引入 omo 全家桶插件。

**Effort**: 中等。约 15 个子任务分 5 波；含 1 次 Prisma migration（Plan.rejectCount + ExecutionPolicy）与 1 次 opencode 通道验证报告。

**Risk**: 中。主要风险在 A1 opencode 通道验证（多 agent 声明/session 指定 agent/config 热加载 3 选 1 结论决定 A3 形态）；B 线为纯 server 校验，无部署风险。

**Decisions**: 详见 Scope 与各 Todo 的 Recommended task executor category。

## Scope
**In**:
- B 线：`planSubmitSchema` 收紧（acceptance/qa 必填）、`plan-quality.guard.ts` 服务端预检（QA 工具词+结构特征 / acceptance 可判定性硬门槛，references 软警告）、`PLAN_REVIEW_CHECKLIST_INSTRUCTION` + `PLAN_WORKFLOW_INSTRUCTION` 升级、Plan 驳回上限（rejectCount + 409）。
- A 线：ExecutionPolicy 一等资源（Prisma 模型 + CRUD + 模板策略 seed）、`execution-policy.service` 解析（policyId 唯一来源）、`worker-protocol.ts` 协议扩展（ExecutionConfig 下发）、`worker-dispatcher.ts` 组装与下发、`worker/src/resources/opencode-config-builder.ts` 通用翻译器（形态由 A1 结论定）、web 策略管理页 + agent 编辑页策略选择器、e2e 验证。
- 文档与测试：B 线 spec 补充、e2e 自定义 agent 绑策略即得能力验证。

**Out / Must-NOT-Have**:
- 不兼容 `agents.permissionScope` / `toolEffects` 旧内嵌机制；不做「引用优先、内嵌兜底」双轨。
- A 线不做双通道实现，A1 结论唯一。
- 不改动 `opencode serve --pure` 以外的 worker 部署形态（除 A1 结论要求的受控调整）。
- 不引入 omo 40+ hooks 全量移植，仅实现 `ExecutionConfig → opencode` 所需最小翻译。
- 不在 worker 内硬编码任何角色→权限映射表。

## Verification strategy
- **单元/契约测试**：B 线 `plan-quality.guard.spec.ts`（纯函数）+ `platform-mcp.service.spec.ts` 补充（缺 acceptance/qa 400、QA 空话打回、references 软警告透出、rejectCount 上限 409）；A 线 `execution-policy.service.spec.ts` + `opencode-config-builder.spec.ts`。
- **类型与 Lint**：`npm run typecheck` / `npm run lint` 在 server、worker、web 各自通过。
- **手动 QA**：B 线通过 MCP `plan_submit` 发送缺要素与空话 QA 计划验证打回信息可操作性；评审者通过 `plan_get` + `plan_review` 验证清单可见性；A 线 e2e：新建自定义 agent 绑定「仓库开发者」策略后发送「帮我改代码文件」指令，验证被物理拦截而非口头拒绝（与对比：绑定「只读」策略时同指令被拒）。

## Execution strategy
- **Wave 1**（B1）：Schema 收紧与服务端预检。无依赖，可立即开始。
- **Wave 2**（B2+B3）：提示词清单与驳回上限。前置 Wave 1（同文件 `platform-mcp.service.ts` 区域）。
- **Wave 3**（A1 并行验证）：opencode 通道验证报告。独立于 B 线，可与 Wave 1 并行。
- **Wave 4**（A2+A3）：服务端策略资源与 worker 翻译器。前置 A1 结论。
- **Wave 5**（A4+A5）：Web 页面与 e2e 验证。前置 Wave 4。
- **原则**：B 线先行交付，A 线单通道；每波内任务可并行，跨波按依赖串行。

## Todos
- [x] 1. 收紧 planSubmitSchema：acceptance/qa 改必填并补充可判定/可执行描述
  References: `server/src/platform-mcp/platform-mcp.tools.ts:257-284`（planSubmitSchema tasks[].item）；`server/src/platform-mcp/platform-mcp.service.ts:935-1015`（planSubmit 校验入口）
  Acceptance: `plan_submit` 提交缺 `acceptance` 或缺 `qa` 的子任务时，zod 层直接返回 400 且 message 指向具体子任务与字段；`references` 描述补充「涉代码必填」；`acceptance`/`qa` 描述含正确示例。
  QA: happy - `curl -X POST /api/v1/platform-mcp -d '{"tasks":[{"title":"t1","what":"...","acceptance":"...","qa":"playwright 打开 /login ..."}]}'` schema 校验通过；failure - 提交 `qa` 为空或仅 `acceptance` 缺失的任务，断言返回 400 且 message 含子任务标题与字段名。Evidence: `server/src/platform-mcp/platform-mcp.tools.spec.ts` 新增用例通过。
  Commit: `feat(plans): require acceptance and qa in plan_submit schema`
  Recommended task executor category: quick - 单文件 zod schema 改动，机械性强。

- [x] 2. 新增 plan-quality.guard.ts 并接入 planSubmit 服务端预检
  References: `server/src/platform-mcp/plan-quality.guard.ts`（新建，纯函数）；`server/src/platform-mcp/platform-mcp.service.ts:988-1030`（planSubmit what 校验后插入）；`server/src/platform-mcp/platform-mcp.tools.ts`（B1a 已改描述）
  Acceptance: `validatePlanTaskQuality` 对 qa 命中工具词表或结构特征（路径/CLI flag/断言关键词）才放行，纯空话（`QA_EMPTY_TALK_PATTERN`）与 <8 字符直接判 errors；acceptance <6 字符或纯结论词（`ACCEPTANCE_EMPTY_PATTERN`）判 errors；references 含内容但无 `/` 或 `.` 时仅记 warnings。`planSubmit` 在 what 校验后调用该函数，errors 非空则抛 `BadRequestException(PLAN_STRUCTURE_INVALID, "计划质量预检未通过（N 项），请修正后重新提交：...")`，warnings 随返回值 `qualityWarnings` 透出。
  QA: happy - 提交 qa 为 `curl POST /api/v1/users 缺少 name 字段，断言 400` 通过；`references: "./src/foo.ts"` 不产生 warning。failure - qa 为 `测试一下` 断言被拒且 message 含「纯空话」「工具＋步骤＋预期结果」指导；acceptance 为 `可用` 断言被拒。Evidence: `server/src/platform-mcp/plan-quality.guard.spec.ts` 覆盖 happy/failure；`platform-mcp.service.spec.ts` 集成用例通过。
  Commit: `feat(plans): add plan quality guard for qa and acceptance executability`
  Recommended task executor category: unspecified-high - 涉及正则与词表边界判定，需手工验证空话/非空话分类。

- [x] 3. 新增 PLAN_REVIEW_CHECKLIST_INSTRUCTION 并升级 PLAN_WORKFLOW_INSTRUCTION（对齐 Momus）
  References: `server/src/chat/worker-dispatcher.ts:52-175`（GLOBAL_SYSTEM_INSTRUCTIONS / PLAN_CAPABILITY_INSTRUCTION / PLAN_WORKFLOW_INSTRUCTION / buildSystemInstructions）；`server/src/platform-mcp/platform-mcp.tools.ts:500-560`（plan_get / plan_review 工具描述）
  Acceptance: 新增常量 `PLAN_REVIEW_CHECKLIST_INSTRUCTION` 文本含 Momus 四项（1 引用核查 2 可起步 3 一致性 4 QA 可执行）+ 判定标准（四项全过 approved，有阻塞 rejected，最多 3 个致命问题，每个含子任务定位与改法）+ 风格问题不构成驳回。`PLAN_WORKFLOW_INSTRUCTION` 升级为含 8 段模板引用（TL;DR/Scope/Verification/Execution/Todos/Final verification/Commit/Success）的完整引导。`plan_review` 与 `plan_get` 的 tool description 追加清单要点（模型调用工具时必然可见）。dispatch 时评审相关提示通过 buildSystemInstructions 注入，无需运行时状态判断。
  QA: happy - 以评审者身份 `plan_get` 后 prompt 中含四项清单文本；plan 模式任务的 system 含升级后的工作流引导。failure - 提交仅含 „评审默认放行" 旧文本的 plan，断言被新提示覆盖。Evidence: 快照测试或字符串包含断言在 `worker-dispatcher.spec.ts`。
  Commit: `feat(plans): inject Momus review checklist and upgrade plan workflow instruction`
  Recommended task executor category: unspecified-low - 文本常量新增与注入点调整，范围小。

- [x] 4. prisma: Plan 增加 rejectCount 字段并完成迁移
  References: `server/prisma/schema.prisma:671-688`（model Plan）；`server/prisma/migrations/`（新增 migration 目录）；`server/prisma/seed.ts`（无需改，但需确认）
  Acceptance: `model Plan` 新增 `rejectCount Int @default(0) @map("reject_count")`；`npx prisma migrate dev --name add-plan-reject-count` 生成 SQL（含 `ALTER TABLE plans ADD COLUMN reject_count INT NOT NULL DEFAULT 0`）；`npx prisma generate` 通过；现有行默认 0。
  QA: happy - `npx prisma migrate deploy` 在空库与存量库均成功；`prisma.plan.findFirst` 返回行含 `rejectCount: 0`。failure - 回滚后重放 migration 幂等。Evidence: migration SQL 文件存在且 `prisma validate` 通过。
  Commit: `feat(plans): add rejectCount to Plan model`
  Recommended task executor category: quick - 单字段 migration，机械性。

- [x] 5. 实现驳回上限：planReview 计数 + planSubmit ≥3 次 409
  References: `server/src/platform-mcp/platform-mcp.service.ts:1094-1150`（planReview）；`server/src/platform-mcp/platform-mcp.service.ts:975-1020`（planSubmit 重提冲突段）；`server/src/plans/plan.constants.ts:45-53`（PLAN_ERRORS 新增码）
  Acceptance: `plan.constants.ts` 新增 `PLAN_REVIEW_ROUNDS_EXCEEDED`；`planReview` 当 `verdict === 'rejected'` 时 `prisma.plan.update({ data: { rejectCount: { increment: 1 } } })`；`planSubmit` 入口若 `existing.rejectCount >= 3` 则抛 `ConflictException(PLAN_REVIEW_ROUNDS_EXCEEDED, "执行计划已驳回 3 次，请向用户同步分歧点并请求人工裁决后再提交")`，不进入 quality guard。
  QA: happy - 连续 3 次 rejected 后第 4 次 submit 断言 409 且 code 为 `PLAN_REVIEW_ROUNDS_EXCEEDED`。failure - approved 后的旧 rejectCount 不影响新周期（新 rejected 从 0 起计需在 planSubmit 覆盖重提时重置为 0）。Evidence: `platform-mcp.service.spec.ts` 中模拟 3 次 rejected 后第 4 次 409。
  Commit: `feat(plans): enforce 3-round rejection cap`
  Recommended task executor category: unspecified-low - 涉及两处事务与常量新增。

- [x] 6. B 线测试补齐与回归
  References: `server/src/platform-mcp/plan-quality.guard.spec.ts`（前置 2 产生）；`server/src/platform-mcp/platform-mcp.service.spec.ts`；`server/src/chat/worker-dispatcher.spec.ts`；`server/src/plans/plans.service.spec.ts`
  Acceptance: 新增用例覆盖：a) 缺 acceptance/qa 400 b) QA 纯空话被拒且 message 含改法 c) references 软警告透出 d) 3 次驳回后 409 e) 清单文本注入断言。`npm run test -- --runInBand` 中相关套件全绿，`npm run typecheck` 通过。
  QA: happy - 上述用例全部通过且覆盖率不下降。failure - 故意提交非法 qa 仍被放行则测试失败。Evidence: `test-results/` 或 CI 日志。
  Commit: `test(plans): cover quality guard, review checklist and rejection cap`
  Recommended task executor category: quick - 用例补充，机械性。

- [x] 7. A1: opencode 通道验证报告（决定 A2 单通道形态）
  References: `worker/src/runtime/opencode-server.ts:288-319`（spawn --pure）；`worker/src/driver/v1-driver.ts:196-212`（createSession body {}）；`worker/src/exec/exec-server.ts`（/execute）；`worker/src/resources/`（custom-tool 注入先例）；opencode 官方 docs（config 发现、agent 声明、session 指定 agent）
  Acceptance: 产出 `docs/agent-platform/A1-opencode-channel-report.md`，含：a) 三通道验证结论（① config 多 agent + session 指定 agent ② per-directory config ③ 运行时插件查表）各自是否可行、是否需重启、token 成本对比（去掉 --pure 后 input tokens 变化，复现 D2 7601 现象与否）b) 热加载验证（新建策略/新 agent 后不重启 serve，下个 createSession 能否生效）c) 明确唯一的 A2 实现通道选型与理由。
  QA: happy - 报告含三通道实测命令与输出截图/日志摘录；结论唯一。failure - 报告未给出唯一选型则不算完成。Evidence: `docs/agent-platform/A1-opencode-channel-report.md` 存在且被 Wave 4 引用。
  Commit: `docs: add A1 opencode channel verification report`
  Recommended task executor category: deep - 需本地实测 opencode serve 行为、对比多配置形态，涉及跨进程与日志分析。

- [x] 8. A2-schema: ExecutionPolicy Prisma 模型 + migration（policyId 唯一来源，退役 permissionScope）
  References: `server/prisma/schema.prisma`（新增 model ExecutionPolicy，修改 model Agent 加 policyId）；`server/src/common/id-generator.ts` / `server/src/prisma/seed.ts:126-230`（agent seed 五角色）；`server/src/agents/agents.service.ts:47-328`（permissionScope 读写点）
  Acceptance: 新增 `model ExecutionPolicy { id String @id // ep_ 前缀; name String; description String? @db.Text; type String // template|custom; config Json // { permissions: Record<string,"allow"|"ask"|"deny">, writePaths: string[] }; createdAt DateTime; updatedAt DateTime }`；`model Agent` 新增 `policyId String? @map("policy_id")` 外键风格（不建 FK 约束，对齐现有 Json 策略风格）；`npx prisma migrate dev --name add-execution-policy` 生成 SQL；`permissionScope` / `toolEffects` 字段标记为 deprecated（保留列但服务端不再读取，读取路径改为 policyId）。
  QA: happy - `npx prisma migrate deploy` 成功；`prisma.executionPolicy.create` 与 `prisma.agent.update({ policyId })` 往返正常。failure - 旧 agent 行 policyId 为 null 时查询不崩。Evidence: migration SQL 与 `prisma validate` 通过。
  Commit: `feat(policy): add ExecutionPolicy model and bind to Agent`
  Recommended task executor category: unspecified-high - 涉及新模型、migration 与存量字段退役。

- [x] 9. A2-service: execution-policy.service 解析 + worker-protocol 扩展 + 组装
  References: `server/src/platform-mcp/`（新增 `execution-policy.service.ts`）；`worker/src/protocol/worker-protocol.ts`（双写类型）；`server/src/chat/worker-dispatcher.ts:1088-1195`（buildSystemInstructions 与 dispatch 下发）；`server/src/agents/agents.service.ts`
  Acceptance: `execution-policy.service.ts` 提供 `resolveExecutionConfig(agent): ExecutionConfig`（输入 agent.policyId 关联的 ExecutionPolicy.config，若不存在则返回平台默认最小权限 `permissions: { "*": "ask" }`），无任何角色硬编码；`worker-protocol.ts` 在 `WorkerExecuteRequest` / `WorkerCreateSessionRequest` 双写类型中新增可选字段 `executionConfig?: ExecutionConfig`；`worker-dispatcher.ts` 在 dispatch 组装阶段调用该 service 并将结果写入下发 payload。
  QA: happy - 自定义 agent 绑定策略 A 后 dispatch payload 含策略 A 的 config；未绑定策略的 agent 返回默认最小权限。failure - 策略被删除后 agent 仍能 dispatch（回退默认）。Evidence: `execution-policy.service.spec.ts` 通过。
  Commit: `feat(policy): add execution policy resolution and protocol extension`
  Recommended task executor category: unspecified-high - 跨 server/worker 协议的双写类型与组装逻辑。

- [x] 10. A2-crud: execution-policies 模块 CRUD + 模板策略 seed
  References: `server/src/execution-policies/`（新建 module/controller/service/dto）；`server/src/app.module.ts`（注册）；`server/prisma/seed.ts:130-280`（新增模板策略 seed，幂等 create 不覆盖）；`server/src/common/guards/`（AdminGuard 对齐 tools 管理）
  Acceptance: `POST/PATCH/GET/DELETE /api/v1/execution-policies` 完整 CRUD，`type=template` 只读（写操作 403），`custom` 可写；DTO 校验 `config.permissions` 值为 allow|ask|deny 枚举，`writePaths` 为 string[]；seed 写入 3-4 条模板策略（只读观察 / 文档协作 / 仓库开发 / 全权，按当前五角色出厂绑定关系初始化 `agents.policyId`）。
  QA: happy - 以 admin 身份创建 custom 策略、绑定到自定义 agent 后查询生效；以 member 身份写 template 返回 403。failure - 非法 permission 值被 400 拒绝。Evidence: `execution-policies.controller.spec.ts` 通过。
  Commit: `feat(policy): add ExecutionPolicy CRUD and template seeds`
  Recommended task executor category: unspecified-high - 新模块全链路（DTO/service/controller/seed/guard）。

- [x] 11. A2-dispatch: worker-dispatcher 完整下发链路打通
  References: `server/src/chat/worker-dispatcher.ts`（dispatch → workerClient.createSession / promptAsync）；`server/src/chat/worker-client.ts`（HTTP 下发）；`worker/src/exec/exec-server.ts`（接收侧）
  Acceptance: `createSession` 与 `promptAsync` 均携带 `executionConfig`；`exec-server.ts` 接收后透传给翻译器入口（不做业务判断）；日志含 `executionConfig` 摘要（不打印完整 JSON）。
  QA: happy - 端到端：server 下发策略 A → worker 日志出现翻译器调用且 opencode 侧生效（由 A3 验证）。failure - 未传 executionConfig 时 worker 不崩（兼容 B 线独立交付期）。Evidence: 集成测试中 mock worker 收到 executionConfig 断言通过。
  Commit: `feat(policy): wire executionConfig through dispatch to worker`
  Recommended task executor category: unspecified-low - 链路透传，改动面小。

- [x] 12. A3: worker 通用翻译器 opencode-config-builder（形态由 A1 结论定）
  References: `worker/src/resources/opencode-config-builder.ts`（新建，纯函数）；`worker/src/runtime/opencode-server.ts`（spawn 形态按 A1 结论调整）；`worker/src/driver/v1-driver.ts`（createSession 参数扩展若通道①）；`docs/agent-platform/A1-opencode-channel-report.md`（前置结论）
  Acceptance: `opencode-config-builder.ts` 导出 `buildOpencodeConfig(executionConfig, channel): OpencodeArtifacts`，输入为 server 下发的 ExecutionConfig，输出为 opencode 形态（按 A1 选型：a) 多 agent 声明片段 + session 指定 agent 名 b) per-directory config c) 插件查表配置），零角色知识（无 if role 分支）；`opencode-server.ts` 的 `--pure` 取舍按 A1 实测 token 数据实施受控调整。
  QA: happy - 给定 `permissions: { write: "deny" }` 的 config，翻译后 opencode 侧对写工具返回 deny；给定 `write: "allow"` 则放行。failure - 未知 channel 值抛错而非静默。Evidence: `worker/src/resources/opencode-config-builder.spec.ts` 覆盖三类权限与路径白名单。
  Commit: `feat(worker): add opencode config builder for execution policy`
  Recommended task executor category: deep - 需按 A1 结论实现不同形态的 opencode 侧生效，涉及进程级配置与会话级选择。

- [x] 13. A4-policy-page: 策略管理页（权限矩阵 + 路径白名单）
  References: `web/src/app/(main)/execution-policies/`（新建页面，对齐 `web/src/app/(main)/agents/` 骨架）；`web/src/lib/api/execution-policies.ts`（新增 API client）；`web/src/components/`（复用表格/表单/Tag 输入组件）
  Acceptance: 列表页展示 template/custom 标记、config 摘要（权限数/路径数）；创建/编辑页：权限矩阵（每行一个工具，allow/ask/deny 三态切换，工具列表来源于 `config.permissions` keys，新增工具为文本输入+三态）；写路径白名单为 Tag 式输入（回车新增，× 删除）；template 行只读且提供「克隆为自定义」按钮。
  QA: happy - 创建 custom 策略后列表出现，编辑后详情刷新一致；以 template 克隆后新策略为 custom 且可编辑。failure - 非法 permission 值提交被前端校验拦截。Evidence: Playwright 用例覆盖创建→编辑→克隆流程。
  Commit: `feat(web): add execution policy management page`
  Recommended task executor category: visual-engineering - 前端页面与交互，需对齐现有设计系统。

- [x] 14. A4-agent-page: agent 编辑页策略选择器
  References: `web/src/app/(main)/agents/[id]/`（编辑页）；`web/src/lib/api/agents.ts`（agent 更新 payload 扩展 policyId）；`web/src/lib/api/execution-policies.ts`（策略下拉数据源）
  Acceptance: agent 创建/编辑表单新增「执行策略」下拉（数据源为 execution-policies 列表，含 template + 自己的 custom，显示 name 与 type 标记）；选择后保存，详情页展示当前绑定策略名；未选择时显示「默认最小权限」提示。
  QA: happy - 新建自定义 agent 选择「仓库开发」策略后保存，刷新后仍为该策略；切换策略后生效。failure - 未选择策略保存不崩。Evidence: Playwright 用例覆盖选择与展示。
  Commit: `feat(web): add policy selector to agent editor`
  Recommended task executor category: visual-engineering - 表单扩展与联动。

- [x] 15. A5: e2e 自定义 agent 绑策略即得能力验证 + 五角色默认绑定
  References: `server/prisma/seed.ts`（五角色默认 policyId 绑定：产品/项目经理→文档协作、架构师→只读、开发者→仓库开发、测试→仓库开发）；`docs/agent-platform/A1-opencode-channel-report.md`（通道形态）；`server/test/e2e/` 或 `web` e2e 目录
  Acceptance: seed 幂等：五模板 agent 的 `policyId` 按上述映射初始化；e2e 脚本：a) 创建自定义 agent 绑定「只读」策略，发送「帮我改代码文件」指令断言被物理拦截（tool deny） b) 同 agent 改绑「仓库开发」策略后同指令放行；两条链路均产出证据日志。
  QA: happy - e2e 全绿且日志含 executionConfig 与翻译器调用摘要。failure - 绑定只读策略仍放行则失败。Evidence: e2e 日志与 `test-results/`。
  Commit: `test(e2e): verify custom agent policy binding grants capability`
  Recommended task executor category: unspecified-high - 跨 server/worker/opencode 的端到端验证。

## Final verification wave
- [x] F1. 计划合规审计 — 抽查 Todos 中引用的文件路径是否真实存在且内容相符；每条 todo 的 References 是否可追溯、Acceptance 是否无歧义、QA 是否含具体工具与断言。
  Recommended task executor category: unspecified-high
- [x] F2. 代码质量 review — 检查新增模块是否引入 AI slop（过度抽象、未使用抽象、重复文本）；opencode-config-builder 是否零角色知识；execution-policy.service 是否无硬编码角色分支。
  Recommended task executor category: unspecified-high
- [x] F3. 真实手动 QA — 按 Verification strategy 执行：B 线 plan_submit 打回路径、评审清单可见性、A 线自定义 agent 绑策略能力切换。
  Recommended task executor category: unspecified-high
- [x] F4. 范围保真 — 核对 Scope 的 Must-NOT-Have 是否被遵守（无兼容双轨、无双通道、无 worker 硬编码映射、无 omo 全家桶）。
  Recommended task executor category: unspecified-high

## Commit strategy
- 每完成一个 Todo 即提交一个 commit，message 前缀按 `feat/fix/docs/test` + 域（`plans/policy/worker/web`），便于按波回滚。
- Prisma migration 单独 commit（Todo 4、8），不与业务代码混提交。
- A1 报告（Todo 7）为 `docs:` 前缀，不触发构建。
- 最终合并且打 tag 前 `npm run typecheck && npm run test -- --runInBand` 全绿。

## Success criteria
- B 线：缺 acceptance/qa 的计划被 schema 层 400 拒绝；QA 空话（"测试一下"）被 `PLAN_STRUCTURE_INVALID` 打回且 message 含改法示例；缺路径引用的 references 产生 qualityWarnings 透出；评审者通过 `plan_get` 可见 Momus 四项清单；同一计划 3 次 rejected 后第 4 次 submit 返回 409 `PLAN_REVIEW_ROUNDS_EXCEEDED`。
- A 线：ExecutionPolicy 为一等资源可页面 CRUD（template 只读可克隆）；自定义 agent 绑定策略后 capability 随策略切换而切换（e2e 验证只读→拒绝写、开发→放行）；worker 翻译器零角色知识；全链路「server 定规则→协议下发→worker 盲翻→opencode 生效」可追踪；五模板 agent seed 绑定默认策略幂等生效。
- 质量：新增 spec 全绿，Final verification wave 四项均 APPROVE。

