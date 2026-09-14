# Draft: vteam 角色行为强化与越权拦截（种子数据 + 提示词 + 工具权限）

## Meta
- slug: vteam-role-behavior-enforcement
- intent: clear
- review_required: true
- created: 2026-09-12
- status: plan-written

## Context（当前功能分析 · 已核实）
- 5 个模板 Agent 在 `server/prisma/seed.ts:115-278`（`a_product`/`a_project_manager`/`a_architect`/`a_developer`/`a_tester`）：有 prompt（四方向）+ persona + permissionScope，**没有** skillIds / toolEffects 关联行。
- seed 幂等策略：`seed.ts:285-297` 的 update 分支**只同步 prompt**；`seed.spec.ts:65` 断言 `Object.keys(update)==['prompt']`（改种子须同步改该 spec）。
- 提示词注入链：`server/src/chat/worker-dispatcher.ts:268-335 buildSystemInstructions`（GLOBAL_SYSTEM_INSTRUCTIONS + 身份段 + 【职责】agent.prompt + persona + 主 Agent 段 + 团队段）。GLOBAL_SYSTEM_INSTRUCTIONS（同文件 77-99）对**所有角色**一视同仁。
- **工具权限当前完全未生效（核心发现）**：
  - `agent_tool_effects`（schema.prisma:510-521）与 `agents.permissionScope`（schema.prisma:463）只被 CRUD/`my_profile`/前端展示读取，**运行时无任何消费点**。
  - 设计中的 `ExecutionPolicy`（schema.prisma:485-495）+ `ExecutionPolicyService.resolveExecutionConfig`（server/src/platform-mcp/execution-policy.service.ts:18-39）+ `ExecuteOptions.executionConfig`（worker.client.ts:164-165）+ worker `opencode-config-builder.ts` 全是**死代码/未接线**；worker 仅把 executionConfig 写成 `.execution-config.json` 不生效（exec-server.ts:1116-1126）。
  - `execution-policies.module.ts` 空模块未注册；`web/.../execution-policies/page.tsx` 3 行占位。
  - 唯一真正的硬拦截 = platform-mcp.service.ts 写死的「仅主 Agent」门 + worker 归属校验。
- 所有角色默认跑同一个 opencode 默认 agent，共享相同原生工具（bash/read/edit/write/grep/glob + git_* + browser）与全部 vteam MCP 工具 → 行为趋同。
- `TeamMember.opencodeAgentName` 只作用于主 Agent 成员，且只是「选一个已存在的 opencode agent」，不定义其权限（web session page:1271-1281；getOpencodeAgentDuty 判计划职责）。
- 文档 16 给出 4+1 角色理想默认；`project_manager` 无文档默认；实现第 5 角色是项目经理（非文档的 UI 设计）。
- 机制可行性已核实：opencode 原生支持 opencode.json `agent.<name>` 的 `permission`(allow/ask/deny) 与 `tools:{name:false}`；插件 `tool.execute.before` 可 throw 拦截并回传错误消息；worker 默认**不加** `--pure`（可加载插件）。
- 可复用骨架：`.omo/plans/vteam-agent-strengthening.md` + `docs/agent-platform/A1-opencode-channel-report.md`（选定通道①：config 多 agent + session 指定 agent），其 Wave4/5 未落地。

## Decisions（用户已拍板）
1. 角色集：**保留 5 角色，重划职责边界**（产品=需求+原型；架构师=技术方案/设计文档；开发者=编码实现；测试=测试全流程；项目经理=流程管控）。
2. 越权拦截：**接通硬拦截 ExecutionPolicy→opencode permission**（复用现有骨架，不新增第二套模型）。
3. 纠偏：**专职 guard 拦截**（平台级越界检测，拦截并回强制纠正指令给该 agent）。
4. 测试：**tests-after + 更新 seed.spec + e2e 行为验证**（含 agent 可执行 QA）。

## Components（可独立成功/失败）
1. 提示词强化：五角色提示词按新边界重写（职责/权限/工作方式/协同/自检），seed 同步。
2. 权限策略种子：5 条角色 ExecutionPolicy（permissions + tools + 纠偏话术）+ 角色→策略绑定 + seed 幂等/升级语义。
3. 硬拦截落地：server 解析策略→下发 worker→worker 写 opencode.json `agent` 节→dispatch 指定 `agent` 名。
4. 专职 guard：worker 注入 opencode 插件 `tool.execute.before`，按 session→角色策略校验并 throw 纠正信息。
5. 双面覆盖：原生工具（bash/edit/write/git_*/browser）+ vteam MCP 工具（submit_artifact/issue_*/group_post/notify_agent…）。
6. 验证：seed.spec 更新 + 单测 + e2e（绑只读角色后写操作被物理拒绝 + 越界得到纠正提示）。

## Open Assumptions（已采用默认，可被否决）
- 权限唯一事实源 = ExecutionPolicy（模板角色 seed 绑定 policyId）；`permissionScope`/`toolEffects` 运行时退役（保留列与展示，不再作为 enforcement 来源），不做双轨。
- 策略 agent 命名 `vteam-<role>`；计划模式沿用现有 plan 指令分流，权限按角色策略执行。
- 「出厂默认」seed 对 prompt/policyId 做版本同步；用户已自定义的 clone/custom agent 不被覆盖。
- guard 用 worker 侧 sessionId→agent 映射文件解析角色；插件抛错消息即纠正指令。若 serve 对 opencode.json 有进程级缓存，回退 `restart-coordinator` 重启。

## Approval Gate
- 用户「继续」= 授权，计划已生成：`.omo/plans/vteam-role-behavior-enforcement.md`。
- 结构：修订后 24 个实现 todo（`- [ ] N.`）+ 4 个最终验证（`- [ ] F<n>.`），分 5 波。
- 用户选择「先跑高精度双评审」→ review_required=true。
- plan_sha256（评审员回显）= 98c72ea29743ec1926382fc6cc213a3840b440a2ff4c052c9a70e84401aea7be（round1）。
- **Round 1（rr-20260912-role-enforce-1）结果：双双 CHANGES_REQUESTED**
  - momus-1（bg_a9a3b6bc / ses_f69d24c81ffeVk0LwL4JEZeyzu）：3 阻断 — M1 优先级引用不存在的 `planMode.agentName`；M2 Todo20 e2e 不可复现；M3 `<taskDir>` 占位未解析 + fail-closed 与 pure 矛盾。
  - oracle-1（bg_2eebbb31 / ses_f69d220f6ffeVPccEeHi2xQZ10）：6 阻断 — O1 证伪"原生 permission 不能按路径"（其实支持 edit 路径 glob）；O2 pure 下 fail-closed 不可能；O3 优先级自相矛盾/回归 opencodeAgentName；O4 旧 worker 无能力位→unknown agent；O5 子代理 session 未覆盖；O6 cleanupByManifest 新键误删 tools。
- **修复（已写入计划）**：层① 原生 `permission` 路径 glob 为主强制（pure 下仍生效）；层② guard 降为 bash 硬化+纠偏；新增 Degradation states 表；优先级改为策略权威+能力位+回退现状；Todo14 能力位上报；Todo19 子代理处理；Todo15 cleanup 显式分支；Todo21 可复现 e2e 脚本。
- **Round 2（rr-20260912-role-enforce-2）结果：双双 CHANGES_REQUESTED**（plan_sha256=4380273d24f015535034587c78f7d791c8fe6aa95ae21f84d4be250421854278）
  - momus-2：2 阻断（均 Todo21）——`/execute` fire-and-forget 202 无法回读错误子串；ask 权限确认缺成员 JWT。M1/M3 已确认修复。
  - oracle-2：4 阻断——glob 基址错（非 git worktree=`/`，`tasks/*/...` 不命中；绝对路径对 edit 无效）；`opencode.json` 并发写丢节；能力位只查 enabled 不查 names（stale-true→unknown agent）；`write` 非 opencode 原生 permission（`edit` 才是 edit/write/patch/multiedit 闸门）。
- **修复（已写入计划）**：Todo2 glob 基址 spike + 根无关 `**/tasks/*/...`（排除绝对路径）；Todo15 单写者；Todo13/14 `enabled && names.includes`；Todo12/20/24 edit-only + write/patch/multiedit→edit 映射；Todo21 serve 回读 + 成员 JWT + INCONCLUSIVE。
- **Round 3（rr-20260912-role-enforce-3）结果：双双 CHANGES_REQUESTED**（plan_sha256=7b72b364da0e454284d22a5ae52f64927085c1add773c9557f395451f579897c）
  - momus-3（3 阻断，均 Todo21）：seed-member 非示例团队成员→questions API 403；env 缺 `WORKER_EXEC`；`OPENCODE_SERVE_PASSWORD` 非 worker 读取（真实 `OPENCODE_SERVER_PASSWORD`）。
  - oracle-3（4 阻断）：**证伪"子代理继承父级拒绝"**（仅继承父 session 权限）→ 层① 可经 `task` 绕过；guard 配置源缺失 + `.vteam-role-guard.json` 文件 vs `.vteam-role-guard/` 目录路径分裂；guard 工具映射漏 `apply_patch`（`multiedit` 在 1.18.30 不存在）；通用 glob 判定规则不完整（`worktree===WORK_DIR` 时 `**/tasks/...` 不命中）+ `git init` 回退自败。
- **修复（已写入计划）**：所有角色 `permission.task:"deny"` + guard 未知 session 拒 `task`；guard 单一路径 `roles.json`+`sessions/`；`edit`/`write`/`apply_patch`(+patch/multiedit) 映射 edit；glob 改通用根无关 `**tasks/*/<subdir>/**`、删 `git init` 与绝对路径；Todo21 用 seed-admin + `WORKER_EXEC_URL` + `OPENCODE_SERVER_PASSWORD`（并修 README 笔误）。
- **Round 4（rr-20260912-role-enforce-4）结果：双双 CHANGES_REQUESTED**（plan_sha256=bbcb0f824aa385197b193c34c8da1debad7e527e39595d73cda94f641bd95ff2）
  - momus-4（3）：Todo21 c ask→reply 不可达（直连 serve 绕过服务端绑定、payload 缺 agentId→forwardReply 503）；Todo21 b pure 无法由脚本触发（env 属 worker 进程）；波次注记漏 14→15。
  - oracle-4（4）：Todo21 f task 断言不可满足（task 被 deny 后不可见，无被拒调用）；guard 生命周期/cleanup 未移除插件文件与 plugin 条目；roles.json key 命名空间不一致（role vs agentName）；guard 默认姿态未定义（execute/custom/MCP 可变更）。
  - 非阻断更正：`EDIT_TOOLS` 符号不存在（内联列表）；`apply_patch` 参数为 `{patchText}` 非 `filePath`。
- **修复（已写入计划）**：Todo21 c 改平台正常分派绑定 Session（`session-lifecycle.service.ts:80,149`）+ reply 200 断言；b 并入 Todo17（worker 侧重启 pure 断言）；f 改契约级确定性断言；guard 加 `enabled` 哨兵 + cleanup 移除插件条目/文件；全链 key 统一为 opencode agent 名；guard 默认拒绝 allowlist 外工具并显式 deny `execute`；波次改 Wave3=15→14→13、16、17 并修正依赖注记。
- **Round 5（rr-20260912-role-enforce-5）结果：一票通过、一票拒绝**
  - **momus-5：APPROVED ✅**（artifact_identity=ced9744567f8967d8d79c20ee1c5991230947df32592ce11017a9a1a065156a6）；3 条非阻断更正（schema `:464`、seed.spec 路径、群聊路由）已并入。
  - **oracle-5：CHANGES_REQUESTED（4）**：① MCP 真实暴露名为 `vteam_<action>`，计划用裸名会导致 guard 默认拒绝所有 vteam MCP 工具；② guard 默认拒绝与层① `permission.read:allow` 冲突且未给 bash/read 分支优先级；③ `/agent-policies` 拉取失败会残留 `enabled:true` guard → 全平台 fail-closed DoS；④ e2e(f) "live 会话工具清单"无可执行来源。
- **修复（已写入计划）**：工具名统一真实暴露名 `vteam_<action>`（前缀取自 `seed.ts:427-440`，Todo 24 校验与注册表一致）；Todo 20 明确分支优先级（read 类交层①、edit 类按 writeGlobs、bash 仅硬化、task/execute deny、仅未知/自定义/MCP 走 allowlist）；Todo 15 失败中性化（写 `enabled:false` + 移除插件与条目）+ 未映射 session pass-through；Todo 21(f) 改配置契约 + 单测；Todo 17 pure 措辞限定原生 edit/write。
- **Round 6（rr-20260912-role-enforce-6）结果（同一 SHA 重投）：双双 CHANGES_REQUESTED**
  - **momus-6（1）**（artifact=07cc0250…）：Todo 24 注册表断言与自定义 `git_*` 矛盾。非阻断：架构师 git 与矩阵不一致。
  - **oracle-6（3）**：① 同上 Todo 24（已先修）；② `permission.task="deny"` 是**运行时 ask→DeniedError 拒绝**而非"工具隐藏"，且 worker 无 opencode 依赖不能 import `Permission.disabled`；③ guard 默认拒绝误伤内置 `question`/`skill`/`plan_exit`/`browser`。非阻断：corrupt roles.json 解析失败需 pass-through。
- **修复（已写入计划）**：Todo 24 按命名空间校验 + 展开矩阵简写；架构师补只读 git；Todo 21(f) 改"运行时拒绝 + guard 策略单测（不 import opencode）"；Todo 20 增内置通行集（`question`/`plan_exit`/`skill` 放行、`browser` 按 allowlist）并把默认拒绝限定为未知/自定义/MCP；roles.json 解析失败 pass-through；Success criteria 同步。
- **Round 7（rr-20260912-role-enforce-7）结果：双双 APPROVED ✅✅**（plan_sha256=c8bb0dd5d7cafefebda2d669760b343dd20947a3ab11c4f7ea2e8c58d141910d）
  - momus-7：APPROVED（session ses_f6742367effePTufHkYA6J8X9V）；4 条非阻断一致性记录。
  - oracle-7：APPROVED（session ses_f6741fa07ffeh8T45kkNxOf8FY）；确认三项 round-6 修复对 opencode 1.18.30 完整可落地；6 条非阻断 + 2 条 watch-out。
- **状态：plan-approved（高精度双评审通过，回执齐备）。** 未再改动计划文件以保持评审 SHA 有效；两评审的非阻断记录作为执行期提示随交付说明给出。
- 规则：两评审任一 CHANGES_REQUESTED → 逐条修复后重投，直到均 APPROVED。
