# sensitive-command-tool - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** 一个内置的“敏感命令执行”工具。模型可以请求执行一条需要密码或 Token 的命令，用户在聊天弹窗里填写并确认，命令在 worker 上执行；模型只看到命令模板、脱敏后的输出和执行状态，输入值不进入模型上下文。

**Why this approach:** 敏感值走一条独立通道（浏览器 → server → worker），不复用现有会被持久化和回显的问题回复路径；命令执行放在 worker 的 token 保护同步路由里，脱敏在离开 worker 前完成。为避免阻塞调用被超时切断，计划显式注入 MCP 超时而不是依赖客户端默认行为。

**What it will NOT do:** 不提供沙箱、网络出口策略或命令白名单；不保存或复用 secret；不确保能阻止模型把输入编码后外传，脱敏只做精确值替换，属于防顺手泄露而非安全边界。

**Effort:** Large
**Risk:** High - 全角色可请求任意命令，且模型可见脱敏输出；安全边界已明确接受为 best-effort。
**Decisions to sanity-check:** 全角色（含外部/访客）默认可用；阻塞等待采用 540 秒输入预算；托管模式下 fail-closed 直接拒绝；默认执行目录为任务 worktree，不存在则回落 worker 根目录。

Your next move: approve this plan and hand it to a worker with `$ulw-execute sensitive-command-tool`; or run the optional high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Large/High: 13 implementation todos + F1-F4 implement `secret_command` (all roles), non-echoing `secret_input` questions, token-guarded worker `/secret-command` with exact-value redaction, web secret modal and awaiting-input card, plus F3-discovered remediation for que id resync, live team-scope question delivery, and the opencode ~240s blocking-call abort; no sandbox/network policy/allowlist; best-effort redaction.

## Scope
### Must have
- 新增平台 MCP 工具 `secret_command`：模型提交命令模板与变量声明，不提交值。
- 新增能力点 `secret.command`，并让 7 个内置角色、3 个外部引擎角色与 `ar_general` 在 fresh install 与 upgrade 两条路径都显式可用。
- 新增 `secret_input` 问题类型：只持久化模板与变量元数据，不持久化、不回显、不广播 secret 值。
- 新增 worker token 保护的同步 `POST /secret-command`：异步执行、进程组超时取消、精确值脱敏、每流 32KB 截断、cwd 约束。
- 新增 server 侧阻塞式处理器：输入预算 540s；等待与执行期间每 60s 调用 `WorkerDispatcher.keepAliveSession(sessionId)` 重臂 600s 静默看门狗；总预算 = 540s + commandTimeout + 15s；单会话单 in-flight；取消/过期/重复提交有明确状态。
- 新增 Web 敏感输入弹窗：只读命令模板、reason、password 字段、必填校验、取消/确认、刷新补拉、刷新后队列逐个显示。
- 工具卡新增 `awaiting-input` 状态，模型只收到原始模板 + 脱敏输出 + 状态/exitCode/durationMs。
- 为注入的 vteam MCP 远端条目硬编码显式 timeout（≥900000ms，覆盖 855s 最坏总预算；可用 `VTEAM_MCP_TIMEOUT_MS` 覆盖），不依赖 OpenCode 默认值，不要求 DB 迁移。
- 跨包 no-leak 测试：sentinel secret 在 server/worker 日志、SSE、answers、tool result、opencode session store 中 0 命中。
- 文档说明使用方式、权限默认与安全边界。

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不做沙箱、容器/namespace 隔离、seccomp、ulimit、只读文件系统。
- 不做网络出口策略、DNS 限制或代理要求。
- 不做命令白名单/黑名单；模型可写任意命令，这是已接受的 MVP 风险。
- 不建 secret vault、不做凭据落库、轮换或跨调用复用。
- 不新增数据库表/列/迁移来存 secret；`mcp_servers` 不加 timeout 列。
- 不新增 SSE 事件类型，复用 `agent.question`。
- 不复用无鉴权、异步 202 的 `POST /execute` 来执行敏感命令。
- 不复用现有 `questions.answers` 明文持久化/回显路径传 secret。
- 不把渲染后的命令、argv、cwd、secret 或未脱敏错误 message 放进日志、SSE、tool result 或审计记录。
- 不做命令模板可视化编辑器、历史查询页、后台任务或交互式 stdin。
- 不改 SSE/群聊/消息存储契约；不改移动端布局。
- 不把“脱敏”描述为安全边界；文档必须写明变形/外传无法阻止。

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after; server/worker use Jest, web uses TypeScript + Playwright; each todo adds its own failing-first or characterization test before production edit where a seam exists.
- Security-sensitive invariants are proven with sentinels, not visual inspection: `grep -R "s3cr3t-A9f"` over server log, worker log, SSE capture, question answers, tool result JSON, and `~/.local/share/opencode` session store must return 0 hits.
- Contract/parity gates: `cd server && npx jest src/common/constants src/prisma src/questions src/platform-mcp src/workers src/chat/worker-dispatcher.spec.ts --runInBand`; `cd worker && npx jest src/exec src/protocol src/resources --runInBand`; `cd worker && npm run typecheck`; `cd web && npx tsc --noEmit`; `cd web && npx playwright test session-unification.spec.ts chat-density.spec.ts --reporter=list`.
- Full gate: `bash scripts/gate.sh` (no `--with-playwright`) must print `GATE GREEN`; live Playwright is run separately on `localhost:3001` after the web container is rebuilt.
- Evidence: one file per todo under `.omo/evidence/sensitive-command-tool/`, for example `task-1-capability.txt`, with raw logs kept beside it. `attemptDir` is `.omo/evidence/sensitive-command-tool/` outside ulw-loop; inside ulw-loop the executor may use its own attempt directory but must record the literal path in the todo evidence line.

## Execution strategy
### Parallel execution waves
- **Wave 1 — Foundation (4 todos, parallel where files do not overlap):** 1 capability/authorization plumbing; 2 `secret_input` question lifecycle; 3 worker sensitive-command module; 4 worker `/secret-command` route. Todo 4 depends on 3; 1 and 2 are independent server files.
- **Wave 2 — Delivery chain (3 todos):** 5 WorkerClient; 6 MCP tool + blocking handler; 10 docs. Todo 6 depends on 1, 2, 5; 5 depends on 4. Docs 10 depends on 1, 6.
- **Wave 3 — UI + integration (3 todos):** 7 Web secret modal; 8 tool-card awaiting state; 9 cross-package no-leak integration. 7 depends on 6; 8 depends on 7; 9 depends on 3,4,5,6,7,8.
- **Wave 4 — F3 remediation (3 todos):** 11 que id resync; 12 live team-scope question delivery; 13 MCP blocking-call abort probe/heartbeat. These were discovered by F3 lane B and must land before the final wave re-runs.
- **Final wave (F1–F4):** runs after all implementation todos, all four must APPROVE on the fixed build before completion is declared.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 6,7,9,10 | 2,3 |
| 2 | none | 6,7 | 1,3 |
| 3 | none | 4,5,9 | 1,2 |
| 4 | 3 | 5,6,9 | none in wave 1 |
| 5 | 4 | 6,9 | 10 |
| 6 | 1,2,5 | 7,8,9,10 | none |
| 7 | 6 | 8,9 | none |
| 8 | 7 | 9 | none |
| 9 | 3,4,5,6,7,8 | F1–F4 | none |
| 10 | 1,6 | none | 7,8 |
| 11 | none | 12, F1–F4 | 13 |
| 12 | 11 | F1–F4 | 13 |
| 13 | none | F1–F4 | 11 |
| F1–F4 | all implementation todos (1–13) | completion | each other, read-only lanes |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. **注册 `secret_command` 能力并完成全角色授权链路**（commit `8a87765`）
  What to do: 在 server 常量、seed、迁移与覆盖测试中把 `vteam_secret_command` 纳入 `VTEAM_MCP_TOOL_NAMES`，新增能力点 `secret.command` 且 `defaultDeny:false`，并让 7 个内置角色、3 个外部引擎角色和 `ar_general` 的 fresh install 与 upgrade 路径都得到显式 `true`；`EXTERNAL_AGENT_ROLE_TOOL_ALLOWLIST` 从 8 项扩到 9 项，同步 `seed.spec.ts` 外部 8→9 与 factory 14-false 断言；补齐 `toolAllows` 镜像与迁移，避免“fresh 拒绝、upgrade 允许”的分裂。Must NOT: 不得依赖“缺失键=允许”作为唯一授权机制；不得改现有工具权限语义；不得改变 factory 矩阵中其他 14 个 false 的语义。
  Parallelization: Wave 1 | Blocked by: none | Blocks: 6,7,9,10
  References: `server/src/common/constants/agent.constants.ts:117-149,194-217,281+`；`server/src/common/constants/agent.constants.spec.ts:127`（31→32）；`server/src/common/constants/platform-capability.constants.ts:23-40,216-248,269-279`；`server/src/common/constants/agent-role.constants.ts:224-249,295-509`；`server/prisma/seed.ts:90-127,1142-1149,1399-1430`；`server/src/prisma/agent-role-capabilities-split-grouped.migration.spec.ts:84-133`；`server/src/prisma/agent-role-capabilities-factory-default.migration.spec.ts`；`server/src/common/constants/platform-capability.coverage.spec.ts:30-58`；`server/src/prisma/seed.spec.ts:1168-1180`；迁移目录 `server/prisma/migrations/`。
  Acceptance criteria: `capabilityKeyForTool('vteam_secret_command') === 'secret.command'`；`VTEAM_MCP_TOOL_NAMES` 含新工具且目录覆盖率 spec 由 28/31 更新为 29/32、`agent.constants.spec.ts` 工具数 31→32；所有内置角色、`EXTERNAL_AGENT_ROLE_CAPABILITIES`（allowlist 9 项）、`ar_general` 出厂矩阵中 `secret.command === true`；factory 断言仍只把 `secret.command` 视为新增 true 而不改变其余 14 个 false；`grep -c vteam_secret_command` 在 src 与 seed 镜像中一致；`cd server && npx jest src/common/constants src/prisma --runInBand` exit 0。
  QA scenarios: happy — `cd server && npx jest src/common/constants src/prisma --runInBand` exit 0，并断言新能力点在每个矩阵中为 true。failure — 临时移除一个角色的 `vteam_secret_command`，对应的 coverage/seed/migration spec 必须变红，然后恢复。Evidence `.omo/evidence/sensitive-command-tool/task-1-capability.txt`。
  Commit: Y | `feat(mcp): 注册 secret_command 并全角色开放`
  Recommended task executor category: deep-high — 跨常量、seed、迁移和 fresh/upgrade 双形态的权限契约修改，错误会在安装形态之间分裂。

- [x] 2. **新增不回显的 `secret_input` 问题生命周期**（commits `353af23` + `ee3dc6c`；两 commit 原因见 ledger）
  What to do: 增加 `AGENT_QUESTION_KINDS.SECRET_INPUT` 与专用 source；在 `ReplyQuestionDto` 增加可选 `secrets?: Record<string,string> | null`；实现 `createSecretForPlatform()`，只持久化模板与变量元数据；在 `resolvePlatformQuestion` 增加 secret 分支，只持久化 `{provided,filled,actorType,actorId}` 形状；`{secrets:null}` 语义固定为取消：question 终态为 rejected、handler 返回 cancelled，不再执行命令；只有缺失 secrets、未声明变量或终态重复回复返回 400；`isPlatformQuestion` 必须识别新的 secret source，使 secret 回复继续走平台旁路而不转发 worker；`managedMode` 在 `createSecretForPlatform` 之前 fail-closed，直接拒绝且不产生孤儿 pending 行。Must NOT: 不得复用现有 `answers` 持久化/回显路径传明文；不得把 secret 写进 `content`、`answers`、SSE 或日志；不得让 secret question 进入 `forwardReply`。
  Parallelization: Wave 1 | Blocked by: none | Blocks: 6,7
  References: `server/src/questions/questions.constants.ts:6-9,23-31,43-44`；`server/src/questions/dto/reply-question.dto.ts:10-30`；`server/src/questions/questions.service.ts:52-55,151-206,215-250,233-247,574-592,608-710,732-791`；`server/src/questions/questions.controller.ts:63-99`；`server/src/workers/worker-event.ingress.ts:758-882`。
  Acceptance criteria: 单元测试断言 `agentQuestion.update` 的 `answers` JSON 不含任何提交值；`realtime.emit` 的序列化 payload 不含 submitted secret；`{secrets:null}` 为 rejected；未声明 key、缺少 secrets、终态重复回复分别返回 400；`createSecretForPlatform` 在托管团队仍返回 `managedMode:false`，而 provider 侧 `managedMode` 为 true 时工具在创建 question 之前 fail-closed，`agentQuestion.create` 调用次数为 0；secret source 的回复不会进入 `workerClient.questionReply`。`cd server && npx jest src/questions/questions.service.spec.ts --runInBand` exit 0。
  QA scenarios: happy — 带 sentinel `s3cr3t-A9f` 的回复测试中，mock 的 `prisma.agentQuestion.update` 参数与 SSE payload 串均不含 sentinel；hook 收到明文且只在内存。failure — 把明文写进 `answers` 后上述断言必须变红，恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-2-questions-no-echo.txt`。
  Commit: Y | `feat(questions): 新增不回显的 secret_input 生命周期`
  Recommended task executor category: deep-high — 终态持久化、hook 生命周期、托管模式和错误路径共同决定 secret 是否会落库。

- [x] 3. **Worker 敏感命令模块：变量替换、精确脱敏、进程组超时**（commit `c72d68f`）
  What to do: 新增 `worker/src/exec/sensitive-command.ts`，实现 `substituteTemplate`、`scrubSecrets`、`runSensitiveCommand`；使用异步 `child_process.spawn`（禁止 `spawnSync`）并在超时/取消时对进程组发 SIGKILL；`cwd` 必须解析后包含在 worker workDir 内；stdout/stderr/error message 都要在返回前做精确值替换和残留占位符替换，再按每流 32KB 截断；补齐 worker 协议类型与 contract spec。Must NOT: 不得把渲染后的命令、argv、cwd 或 secret 放进日志或错误 message；不得沿用 `custom-tool.ts` 的 `${cmdLabel} failed` 错误模式；不得阻塞 worker 事件循环。
  Parallelization: Wave 1 | Blocked by: none | Blocks: 4,5,9
  References: `worker/src/exec/exec-server.ts:71-115,266-360,431-474`；`worker/src/protocol/worker-protocol.ts:100-279`；`worker/src/protocol/contract.spec.ts:1-30`；`worker/src/resources/custom-tool.ts:69-90`；`worker/src/git/git-tools.ts:365-389`；`worker/src/exec/exec-server.spec.ts`。
  Acceptance criteria: `cd worker && npx jest src/exec/sensitive-command.spec.ts src/protocol --runInBand` exit 0；测试覆盖重叠 secret、正则元字符、多行输出、短 secret、残留 `{{UNBOUND}}`、40KB 截断、cwd `../../etc` 与绝对路径拒绝、异步超时后进程组消失；错误 message 不含 sentinel；`grep -R "spawnSync" worker/src/exec/sensitive-command.ts` 无命中。
  QA scenarios: happy — sentinel 命令输出经脱敏后不含原值且 `exitCode/truncated` 正确。failure — 临时关闭脱敏或改用 `spawnSync`，对应 spec 必须变红，恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-3-worker-redaction.txt`。
  Commit: Y | `feat(worker): 增加敏感命令执行、脱敏与进程组超时`
  Recommended task executor category: deep-high — 安全脱敏、进程树取消与目录约束属于一个不可拆分的正确性核心。

- [x] 4. **Worker `POST /secret-command` token 保护路由**（commit `0ea57ad`）
  What to do: 在 `exec-server` 路由表新增 `POST /secret-command`；使用 `X-Worker-Token` 鉴权，405/401/413/400 分支完整；调用 `runSensitiveCommand` 并同步返回结构化结果；增加 requestId 幂等去重，规则固定为「同 requestId 且同 taskId/sessionId 返回既有结果；同 requestId 但不同归属返回 409」。Must NOT: 不得折叠进无鉴权 `/execute`；不得把 secret 写进访问日志；不得改变现有路由行为。
  Parallelization: Wave 1 | Blocked by: 3 | Blocks: 5,6,9
  References: `worker/src/exec/exec-server.ts:431-474,809-894,1161-1240`；`worker/src/exec/sensitive-command.ts`（新文件）；`worker/src/exec/exec-server.spec.ts`。
  Acceptance criteria: `cd worker && npx jest src/exec/exec-server.spec.ts --runInBand` exit 0；无/错 token 401、非 POST 405、坏 JSON 400、正常请求 200；响应 JSON 不含 secret、不含渲染命令、不含 argv；并发重复 requestId 不产生第二次执行。
  QA scenarios: happy — 真实 HTTP 端口测试命中 200 且响应无 sentinel。failure — 删除 token 检查后测试变红；恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-4-worker-route.txt`。
  Commit: Y | `feat(worker): 新增 token 保护的 /secret-command 路由`
  Recommended task executor category: unspecified-high — 路由与 HTTP 契约清晰，但错误码与鉴权必须完整。

- [x] 5. **WorkerClient 增加 `runSecretCommand` 显式超时客户端**（commit `ed516be`）
  What to do: 在 `worker.client.ts` 增加 `runSecretCommand()`；必须显式传 `timeoutMs = commandTimeout + 5000`，不得使用默认 60s；非 2xx 归一为 `WorkerUnavailableException`；请求体不写日志。Must NOT: 不得把默认 60s 用于 secret 命令；不得在日志中打印请求体。
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 6,9
  References: `server/src/workers/worker.client.ts:306-403,894-980`；`worker/src/protocol/worker-protocol.ts`。
  Acceptance criteria: `cd server && npx jest src/workers/worker.client.spec.ts --runInBand` exit 0；断言请求头含 `X-Worker-Token`、超时参数大于 60s、非 2xx 抛 `WorkerUnavailableException`。
  QA scenarios: happy — mock fetch 200 返回结果。failure — mock 500/超时，断言异常且无请求体日志。Evidence `.omo/evidence/sensitive-command-tool/task-5-worker-client.txt`。
  Commit: Y | `feat(server): 增加 secret-command worker 客户端`
  Recommended task executor category: quick — 单文件客户端方法与超时参数，优先机械实现。

- [x] 6. **MCP `secret_command` 工具与阻塞式处理器**（commit `4831c41`）
  What to do: 在 `platform-mcp.tools.ts` 增加 `SECRET_COMMAND_SCHEMA` 与工具注册；在 `platform-mcp.service.ts` 实现 `secretCommand()`：校验 `taskId/selfInstanceId`、变量名唯一且与模板占位符匹配、cwd 相对安全、timeout 默认 60s 且上限 300s；调用 `createSecretForPlatform` 并阻塞等待，输入预算 540s（不是 600s），总预算 = 540s + commandTimeout + 15s（最坏 855s）；等待与执行期间每 60s 调用新增的 `WorkerDispatcher.keepAliveSession(sessionId)` 重臂内存静默看门狗，并同步重臂 durable `TriggerService` deadline（`worker-dispatcher.ts:1555-1560`），settle 时 `clearInterval`；如果 MCP 客户端在这之前超时/断开，必须把 pending secret question 置为 cancelled/expired，防止幽灵执行；用户取消返回 cancelled；单会话只允许一个 in-flight，重复调用返回 409；在 `worker/src/resources/injector.ts:656-668` 给注入的 vteam 远端条目硬编码 `timeout >= 900000`（覆盖 855s 最坏总预算）；`VTEAM_MCP_TIMEOUT_MS` 覆盖值必须 clamp 到 `>= 900000`，或测试只对默认值断言该下限；无 DB 迁移；响应 envelope 只含原始模板、脱敏输出、状态、exitCode、durationMs、truncated flags；红色错误 message 也必须脱敏；托管模式 fail-closed 立即拒绝；新增错误码。Must NOT: 不得返回渲染后命令或 argv；不得依赖 OpenCode 客户端默认超时；不得写 DB 审计表；不得在 MCP 断开后继续执行。
  Parallelization: Wave 2 | Blocked by: 1,2,5 | Blocks: 7,8,9
  References: `server/src/platform-mcp/platform-mcp.tools.ts:47-52,327-352,832-1066`；`server/src/platform-mcp/platform-mcp.service.ts:4034-4137,6103,6241-6250`；`server/src/platform-mcp/platform-mcp.constants.ts:9-44`；`server/src/platform-mcp/platform-mcp.controller.ts:178-251`；`server/src/workers/worker.client.ts:894-980`；`worker/src/resources/injector.ts:92-93,656-668`；`server/prisma/schema.prisma:860-873`（mcp_servers 无 timeout 列，禁止加迁移）。
  Acceptance criteria: `cd server && npx jest src/platform-mcp/platform-mcp.service.spec.ts src/platform-mcp/platform-mcp.tool-naming.spec.ts --runInBand` exit 0；`cd worker && npx jest src/resources --runInBand` exit 0 且断言注入的 vteam 条目 `timeout >= 900000`、`VTEAM_MCP_TIMEOUT_MS` 可覆盖；happy 返回 `succeeded` 且 JSON 不含 secret；worker 非零 → `failed`；hook `secrets:null` → `cancelled` 且不调 worker；输入超预算 → `expired`/`input_timeout`；MCP 客户端超时 → pending question 被取消；并发第二调用 409；等待期间 keepalive 每分钟至少调用一次且 settle 后停止。
  QA scenarios: happy — 用同步 hook 注入 secret，断言 worker client 收到值、响应含原始模板与脱敏输出。failure — 把默认 60s 或托管模式放行后对应断言变红，恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-6-mcp-handler.txt`。
  Commit: Y | `feat(mcp): 实现 secret_command 阻塞式敏感命令工具`
  Recommended task executor category: deep-high — 跨 server/worker 的阻塞协议、超时预算、托管模式与 no-leak 契约必须在同一决策里锁定。

- [x] 7. **Web 敏感命令输入弹窗**（commit `7c9e307`）
  What to do: 扩展 `RealtimeQuestionEvent` 与 `QuestionModalData.kind` 增加 `secret_input`；在 `question-modal.tsx` 增加只读命令模板、reason、变量字段（`secret:true` 用 password + `autoComplete="new-password"`，非敏感用 text）、必填校验、取消/确认；页面 `questionReplyMutation` 允许提交 `{secrets}` 或 `{secrets:null}`；`{secrets:null}` 与关闭/Esc/遮罩等价，服务端按取消处理并返回 cancelled；刷新补拉 pending secret question；已过期静默关闭；多个 pending 按队列逐个显示，不覆盖当前弹窗。Must NOT: 不得复用现有自定义文本输入的共享 state 存 secret；不得把 secret 写进 URL、SSE 或日志；不得改 managedMode 语义。
  Parallelization: Wave 3 | Blocked by: 6 | Blocks: 8,9
  References: `web/hooks/use-realtime.ts:236-255`；`web/src/components/chat/question-modal.tsx:37-62,82-99,135-356`；`web/app/(main)/teams/[id]/session/page.tsx:380-397,902-947,1553-1559`；`web/app/(main)/models/providers-tab.tsx:576-588`；`web/e2e/session-unification.spec.ts:188-226`。
  Acceptance criteria: `cd web && npx tsc --noEmit` exit 0；Playwright 用 `__sseEmit` 注入 secret_input 后弹窗出现、密码字段类型正确、必填未填时提交禁用、提交 payload 为 `{secrets}`、取消为 `{secrets:null}`、关闭后 DOM 不含输入值；刷新后能补拉并重开。
  QA scenarios: happy — SSE 注入 → 填值 → 提交 → 断言网络 payload 与弹窗卸载。failure — 用 text input 或把值写回 DOM 后断言变红，恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-7-web-modal.txt`。
  Commit: Y | `feat(web): 增加敏感命令输入弹窗`
  Recommended task executor category: visual-engineering — 复用现有弹窗并新增密码字段与 realtime 接线。

- [x] 8. **Web 工具卡等待填写状态**（commit `a8cedf4`）
  What to do: 给 `msg-tool.tsx`/`msg-parts.tsx` 增加 `awaiting-input` 第四状态，展示「等待填写敏感信息」，并在执行完成后展示脱敏输出与状态；状态派生规则必须明确：同一 session 存在 pending `secret_input` question（来自 `agent.question` 或 `GET /questions`）且对应 `secret_command` tool part 仍在 running ⇒ `awaiting-input`，question resolve/reject 或 tool part 终态后清除；不得渲染 secret 值或渲染后命令；新增 testid 并登记。Must NOT: 不得改变既有 running/success/failed 语义；不得把 secret 放进 tool card props；不得只靠 fixture 注入让状态“看起来可达”。
  Parallelization: Wave 3 | Blocked by: 7 | Blocks: 9
  References: `web/src/components/chat/msg-tool.tsx:26-42,52-53,127-153`；`web/src/components/chat/msg-parts.tsx:99-107,171-190`；`web/e2e/chat-density.spec.ts`；`web/e2e/reference/testids.ts:190-231`。
  Acceptance criteria: `cd web && npx tsc --noEmit` exit 0；用 `__sseEmit` 注入一个 running `secret_command` tool part + 一个同 session 的 pending `secret_input` question，断言卡片进入 `awaiting-input`；再注入 `resolved:true` 或 reject，断言状态清除；DOM 不含 sentinel；chat-density 既有断言全绿，既有 testid 零消失。
  QA scenarios: happy — SSE 注入真实 question 事件驱动 awaiting-input，再 resolve 清除。failure — 删除派生规则后状态无法进入或在 resolve 后不消失，断言必须变红；恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-8-tool-card.txt`。
  Commit: Y | `feat(web): 工具卡支持等待填写敏感信息状态`
  Recommended task executor category: visual-engineering — 组件状态与视觉状态样式改动。

- [x] 9. **跨包不回显、取消与超时集成覆盖**（commit `16584d5`，由 `0c683d8` amend 并入 F2 lint 修复）
  What to do: 新增 sentinel 端到端测试：模拟 secret_command 全链路，断言 server/worker 日志、SSE payload、question answers、tool result JSON、opencode session store 中 0 个 sentinel 命中；覆盖取消、输入过期、命令超时、重复提交、并发 409、cwd 越界；把 `SILENT_SESSION_WAKE_MS` 调低后跑完整等待+执行周期，测试态 keepalive 间隔同步缩放到 `SILENT_SESSION_WAKE_MS / 10`（生产 60s 间隔不变），断言 keepalive 在窗口过期前至少被调用一次、没有 `【自动恢复】` wake dispatch、没有 `silent_session_timeout`；再增加反证 QA：临时禁用 keepalive 后同一测试必须出现 wake dispatch/`silent_session_timeout` 并变红；覆盖 worker 首字等待 300s 活性判定不会在 secret 请求等待期间误杀会话；记录 A1-A10 证据。Must NOT: 不得把测试 secret 写入仓库持久文件；不得以人工目视为通过条件；不得用短预算测试掩盖长时间线。
  Parallelization: Wave 3 | Blocked by: 3,4,5,6,7,8 | Blocks: none
  References: 全部前序 todo 的 spec；`server/src/chat/worker-dispatcher.ts:766-773`；`docker-compose.yml:73-74`；`worker/src/exec/exec-server.ts:431-474`；`web/e2e/session-unification.spec.ts:188-226`。
  Acceptance criteria: `grep -r "s3cr3t-A9f"` 对日志/SSE/答案/结果/session store 全部 0 命中；`cd server && npm test`、`cd worker && npm test`、`cd web && npx playwright test session-unification.spec.ts --project=session-unification` 通过；取消后 5s 内 `pgrep` 无进程；40KB 输出每流 ≤32768 字节；把 `SILENT_SESSION_WAKE_MS` 和测试 keepalive 间隔按 10:1 缩放后完整跑完等待+执行周期，断言 keepalive 在窗口过期前至少调用一次且无 wake dispatch、无 `silent_session_timeout`；禁用 keepalive 的反证 QA 必须变红；worker 首字等待活性判定不误杀 secret 等待中的会话。
  QA scenarios: happy — sentinel 全链路无泄露且状态正确。failure — 临时关闭 worker 脱敏后 sentinel grep 必须命中并让测试变红。Evidence `.omo/evidence/sensitive-command-tool/task-9-integration.txt`。
  Commit: Y | `test(secret-command): 补充不回显、取消与超时集成覆盖`
  Recommended task executor category: deep-high — 跨包泄漏证明与取消语义是安全验收核心。

- [x] 10. **记录使用方式与安全边界**（commit `c61cc64`）
  What to do: 在仓库文档中新增一页说明工具用途、模型/用户/执行器职责、权限默认（全角色含外部）、阻塞等待、脱敏限制（变形/外传无法阻止）、无沙箱/无网络策略/无命令白名单、`bash` permission 不会拦截 `secret_command`（只有 `secret.command` 能力与 `toolAllows` 控制），以及运维如何在角色能力里关闭；同时注明 worker 镜像的 opencode CLI 未 pin，MCP timeout 通过注入条目显式保证；worker 进程被强制杀死时其子进程可能成为孤儿，记录为残余风险。Must NOT: 不得写成安全边界承诺；不得把 secret 写入示例。
  Parallelization: Wave 3 | Blocked by: 1,6 | Blocks: none
  References: `docs/` 现有文档风格；`server/src/common/constants/platform-capability.constants.ts`；本计划 Scope OUT。
  Acceptance criteria: `test -f docs/secret-command-tool.md`；文档明确写出 4 类边界与 1 条限制；示例命令不含真实 secret；`grep -R "s3cr3t" docs/secret-command-tool.md` 0 命中。
  QA scenarios: happy — 文档存在且覆盖全部边界。failure — 删除限制说明后检查脚本变红，恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-10-docs.txt`。
  Commit: Y | `docs(secret-command): 记录使用方式与安全边界`
  Recommended task executor category: writing — 面向人与运维的使用/边界说明。

- [x] 11. **修复 `que` requestId 计数器重启续号（P2002 `agent_questions_request_id_key`）**（commit `a30397e`）
  What to do: `IdGeneratorService` 的 `que` 计数器重启归零，而 `agent_questions.request_id` 是 `@unique`，导致重启后新建 secret question 反复 P2002，直到内存计数烧过存量最大值。最小修复：在 `QuestionsService.onModuleInit` 现有 `aq` 续号之后，从 `request_id LIKE 'que_platform_%'` 的数字尾段取最大值并 `idGen.seed('que', max)`；复用 `id-resync.ts` 的 P2021 fail-open 模式；修正 `id-resync.guard.spec.ts:24` 对 `que` 的错误豁免说明（unique 非 PK）。Must NOT: 不改 `request_id` 唯一约束，不改现有 `que_platform_` 格式，不引入新依赖。
  Parallelization: Wave 4 | Blocked by: none | Blocks: 12, F1–F4
  References: `server/src/common/id-generator.ts:38-53`；`server/src/questions/questions.service.ts:100-107,690-691,767-768`；`server/src/common/id-resync.ts:55-107`；`server/src/common/id-resync.guard.spec.ts:22-25`；`server/prisma/schema.prisma:1038`；`server/src/questions/questions.service.spec.ts:503-536`。
  Acceptance criteria: `cd server && npx jest src/questions src/common --runInBand` exit 0；RED-first 测试：mock `findMany` 返回 `que_platform_0000000007`，`onModuleInit` 后 `createSecretForPlatform` 生成 `que_platform_0000000008`；重启后连续创建不再 P2002；guard spec 文案更新后仍绿。
  QA scenarios: happy — 模拟重启续号后创建 secret question，断言 requestId 递增且 insert 成功。failure — 去掉续号逻辑，同一测试必须因 `0000000001` 重复而变红；恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-11-que-resync.txt`。
  Commit: Y | `fix(questions): 重启后从 request_id 续号避免 secret 问题 P2002`
  Recommended task executor category: deep-high — 重启幂等/唯一键续号跨 service 与 guard，错误会在真实重启后才暴露。

- [x] 12. **修复 live `agent.question` 团队域投递（modal 仅刷新补拉生效）**（commit `1b31521`）
  What to do: 生产 create emit 只带真实 `taskId` 且无 `teamId`，而会话页 scope 为 `team:<id>,channel:…,global`；`use-sse.matchesScope` 的 `team:` 分支只接受 `taskId === id || taskId === 'team:'+id`，因此实时帧被丢弃，modal 只能靠刷新补拉出现。最小修复：server 在 `createForPlatform` 与 `createSecretForPlatform` 的 create emit 增加顶层 `teamId`（与 reply/expire/ingress 同形），web 在 `matchesScope` 的 `team:` 兜底增加 `|| payload.teamId === id`；保持 `payload.taskId` 不变以兼容 task-scope 消费者和页面现有守卫。Must NOT: 不改事件名、不改 reply/expire 语义、不放宽跨团队匹配。
  Parallelization: Wave 4 | Blocked by: 11 | Blocks: F1–F4
  References: `server/src/questions/questions.service.ts:624-630,722-734,795-804,890-902,652-667`；`server/src/workers/worker-event.ingress.ts:861-890`；`web/hooks/use-sse.ts:49,65-121,142,248`；`web/app/(main)/teams/[id]/session/page.tsx:798-801,964-987`；`web/hooks/use-sse.scope.test.mjs:92-96`。
  Acceptance criteria: `cd server && npx jest src/questions --runInBand` exit 0；`cd web && node --test hooks/use-sse.scope.test.mjs` exit 0；新增生产形状用例：`{taskId:'t_0000000001', teamId:'tm_0000000001'}` 对 `team:tm_0000000001` → true，`teamId:'tm_OTHER'` → false，缺 `teamId` → false；create emit 断言含 `teamId`；真实浏览器无需刷新即可弹窗。
  QA scenarios: happy — 注入生产形状 SSE 帧，modal 立即出现；failure — 去掉 `teamId` 后同一用例必须变红；恢复后绿。Evidence `.omo/evidence/sensitive-command-tool/task-12-team-scope.txt`。
  Commit: Y | `fix(team-scope): 修复 agent.question 团队域投递`
  Recommended task executor category: deep-high — server 事件形状与 web scope 过滤必须同改，e2e fixture 与真实形状分裂导致过假绿。

- [x] 13. **修复 MCP 阻塞调用约 240s 客户端 abort（心跳或预算决策）**（commit `0987980`）
  What to do: 现场证明注入的 `timeout:900000` 已生效，但 opencode 1.18.32 另有约 240s（60s 扫描相位）的客户端超时，会在第一个 tick 中止零字节的阻塞 `tools/call`。先运行判定探针：让一次真实 secret 等待 >600s，若加入每 ≤60s 心跳后不再 abort，则为 idle-cap，按下列最小修复实现；若仍固定在约 240s abort，则为 age-cap，停止实现并返回计划决策（把输入预算降到 <240s 或改异步 handle+poll），不得继续加配置。最小修复：`platform-mcp.controller.ts` 对阻塞 `tools/call` 在 pending 期间按 ≤60s 写 SSE `:` 心跳/进度帧，最终仍返回合法 JSON-RPC；保持非阻塞流量与 disconnect abort 语义不变。Must NOT: 不改 MCP 方法名/事件名，不破坏 curl/JSON 客户端解析，不加 server 端全局超时。
  Parallelization: Wave 4 | Blocked by: none | Blocks: F1–F4
  References: `server/src/platform-mcp/platform-mcp.controller.ts:86-121`；`worker/src/resources/injector.ts:146-164,692-693`；`/data/vteam-worker/opencode.json`（现场 timeout=900000）；`.omo/evidence/sensitive-command-tool/final-f3-manual.txt`（294.5s abort 与 60s 相位）。 
  Acceptance criteria: 判定探针输出明确 idle-cap 或 age-cap 并落证据；idle-cap 时 controller spec 用 fake timers 断言 pending 期间每 ≤60s 至少一次心跳、最终 JSON-RPC 可解析、disconnect 仍触发 abort；age-cap 时返回计划决策而不是强行实现。
  QA scenarios: happy — >600s 等待期间无 `request aborted`，最终正常返回。failure — 移除心跳后同一探针必须在约 240s abort 并变红。Evidence `.omo/evidence/sensitive-command-tool/task-13-mcp-heartbeat.txt`。
  Commit: Y（仅 idle-cap 修复时） | `fix(mcp): 阻塞工具调用期间维持长连接心跳`
  Recommended task executor category: deep-high — 需要先做区分性实测，再决定改传输还是改计划预算，属于不可由静态推断定的决策。

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. **Plan compliance audit**（PASS）：核对本计划结构、每个 todo 的 References/Acceptance/QA/Commit、提交范围、证据文件存在性和无 secret 泄露；证据 `.omo/evidence/sensitive-command-tool/final-f1-plan-compliance.txt`。
- [x] F2. **Code quality review**（APPROVE，GATE GREEN）：审查 server/worker/web 改动的类型安全、错误路径、日志与脱敏覆盖；独立复跑定向 Jest、worker typecheck、web tsc 和 `bash scripts/gate.sh`（不带 `--with-playwright`）；证据 `.omo/evidence/sensitive-command-tool/final-f2-quality.txt`。
- [x] F3. **Real manual QA**（PASS，live automated + real manual）：在真实栈上用 `secret_command` 全链路跑一次成功、一次失败、一次取消和一次超时；用 sentinel 做 no-leak grep；检查浏览器 console 和 worker 进程清理；证据 `.omo/evidence/sensitive-command-tool/final-f3-manual.txt`。
- [x] F4. **Scope fidelity**（APPROVE，Scope OUT 零违规）：确认 Scope OUT 全部未触碰（无沙箱/网络策略/白名单/DB 审计/新 SSE 事件/移动端改动），无 secret 或渲染命令进入提交或日志，全角色授权在 fresh/upgrade 两形态一致；证据 `.omo/evidence/sensitive-command-tool/final-f4-scope.txt`。

## Commit strategy
- One todo = one atomic commit. Do not batch multiple todos into one commit; do not split a todo across commits.
- Commit messages follow `type(scope): 中文摘要`, using `feat(mcp)`, `feat(questions)`, `feat(worker)`, `feat(server)`, `feat(web)`, `test(secret-command)`, `docs(secret-command)`.
- Product commits must contain only the todo's product/test/doc files. Never commit `.omo/evidence/`, `.omo/plans/`, `.omo/drafts/`, `.omo/boulder.json`, `.omo/ulw-execute/ledger.jsonl`, `.opencode/opencode.json`, or unrelated pre-existing dirty files.
- Before every commit run `git diff --cached --name-only` and verify scope; after every commit run `git show --stat` and record the SHA in the todo evidence.
- No secret, sentinel secret, rendered command, or raw command output may be committed, including in test fixtures. Use obviously fake sentinels and keep them only in test code.

## Success criteria
- `secret_command` is callable by every role (7 built-in, 3 external engine roles, `ar_general`) in both fresh seed and upgrade migration paths, and the permission matrix spec proves it.
- A real model tool call can request a command template; the web modal appears; the user fills secrets and confirms; the command executes on the worker; the model receives `status`, `exitCode`, `durationMs`, `stdout`/`stderr` (redacted and truncated) and the original template.
- Cancelling, expiry, command failure, command timeout, duplicate submit, and concurrent second call all surface distinct, tested outcomes; no request hangs past the budget.
- Sentinel no-leak proof: `s3cr3t-A9f` appears in zero server logs, worker logs, SSE payloads, persisted question answers, tool result JSON, or opencode session store.
- Rendered command, argv, cwd, and raw pre-redaction error messages never leave the worker; the worker response and model envelope contain no `command` execution field.
- Injected vteam MCP entry has an explicit timeout ≥900000ms independent of OpenCode defaults, proven by `cd worker && npx jest src/resources --runInBand`; `VTEAM_MCP_TIMEOUT_MS` override is covered.
- `bash scripts/gate.sh` prints `GATE GREEN`; targeted server/worker Jest, worker typecheck, web tsc, and Playwright session-unification/chat-density suites pass.
- The operator documentation states the all-roles default, the blocking wait, and the best-effort redaction limitation; no claim of sandboxing or guaranteed secrecy.
- Final verification wave F1–F4 all APPROVE, and the user explicitly accepts the result before completion.
