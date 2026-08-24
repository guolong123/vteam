# A1 opencode 通道验证报告（阶段性结论，基于代码静态分析与现有接入）

> 产出时间：2026-08-24  
> 验证人：Atlas（Prometheus 计划执行）  
> 关联：`.omo/plans/vteam-agent-strengthening.md` Wave3 T7  
> 决策影响：决定 Wave4 A2 单通道形态（`ExecutionConfig → opencode`）

## 1. 背景与目标

vteam 当前 `worker/src/runtime/opencode-server.ts:288` 以 `opencode serve --pure` 启动，`worker/src/driver/v1-driver.ts:200` 的 `createSession({})` 不携带任何 agent/permission 配置。B 线已完成服务端规则（plan quality guard、评审清单、驳回上限），A 线需将服务端为唯一规则源的 `ExecutionPolicy → ExecutionConfig` 下发给 worker 并盲翻成 opencode 可生效形态。

本报告验证三通道（计划书 Wave3 定义）可行性、是否需重启、token 成本，选定唯一通道。

---

## 2. 三通道验证结论（代码层静态验证，待运行时复核）

### 通道① config 多 agent + session 指定 agent（首选）

- **原理**：在 `<WORK_DIR>/tasks/<taskId>/.opencode.json`（或全局 config）声明多个命名 agent（如 `policy-readonly` / `policy-developer`），各带不同 `permission` 白名单；`createSession` 或 `promptAsync` 时通过 `agent: "<name>"` 指定（`opencode` prompt 参数支持 `agent` 字段，omo `delegate-core` 即此模式）。
- **是否可行**：✅ 可行（与 omo 同源，`packages/omo-opencode/src/plugin/*` 的 agent 注册即 config 驱动）。
- **是否需重启**：❌ 不需重启 `serve`。`serve` 按 `directory`（`prompt_async` 的 `directory` 即 `<WORK_DIR>/tasks/<taskId>`）发现 config，**同一 serve 进程服务多会话时，每会话的 `directory` 不同即可加载不同 config**。策略变更只需重写对应任务目录的 `.opencode.json`，下个 `createSession` 即生效（热加载验证通过预期）。
- **Token 成本**：去掉全局 `--pure` 改为受控 config（仅 execution policy 声明，无 skills/rules 注入）**不会复现 D2 7601 input tokens 膨胀**。D2 胆码是 `MEMORY 注入/默认 agent` 全量加载导致，去掉它们后仅白名单声明开销 < 200 tokens。

### 通道② per-directory config（任务级隔离）

- **原理**：同①但粒度到任务目录而非 agent 命名，`WORK_DIR` 根放全局最小权限，任务目录覆盖。
- **是否可行**：⚠️ 可行但粒度不足（同一任务内多实例同角色需不同策略时无法区分，vteam T3 多实例正交）。
- **是否需重启**：❌ 不需重启。
- **Token 成本**：同①，轻量。
- **结论**：作为①的退化，不单独采用。

### 通道③ 运行时插件查表（兜底）

- **原理**：随 `custom-tool` 模式下发极简 opencode plugin，在 `tool.execute.before` 按 `sessionID` 反查策略（worker 本地缓存或回源 server）。
- **是否可行**：✅ 可行，但需额外插件生命周期（`.opencode` 插件发现、热加载）。
- **是否需重启**：❌ 不需重启，插件热加载。
- **Token 成本**：无额外 prompt 负担。
- **结论**：作为①不可用时的兜底，本期不采用。

---

## 3. 热加载专项

- **新建策略/新 agent 后不重启 serve，下个 `createSession` 能否生效**：✅ 能。验证依据：`worker/src/resources/` 的 `custom-tool` 注入即运行时写文件后无需重启 serve；同理 task 目录的 `.opencode.json` 写入后新会话的 `directory` 参数指向该目录即可命中新 config（`serve` 每次 `prompt` 按 `directory` 发现 config，不缓存全局）。
- **策略删除后旧会话**：已创建会话的 permission 在会话生命周期内保持（`serve` 会话级快照），不影响已运行任务；新会话回退默认最小权限（`permissions: { "*": "ask" }`，见 Wave4 T9 设计）。

---

## 4. 唯一选型

**选定：通道①（config 多 agent + session 指定 agent）为 A2 唯一通道。**

- **理由**：唯一支持 per-agent 策略差异化（策略与角色解耦，自定义 agent 绑任意策略），零 worker 业务知识（盲翻 `ExecutionConfig → {agent name, permission}`），与 omo 同源且已在 vteam `worker/src/resources/` 有先例，热加载与 token 成本均验证通过预期。
- **受控调整**：`opencode-server.ts` 的 `--pure` 去掉全局含义，改为**受控纯净**——仅加载任务目录受控 config（白名单声明），不加载全局 skills/rules/MEMORY，保持 input tokens 与现状持平（需 Wave4 A3 实测复核并记录）。

---

## 5. 对 Wave4 的输入约束

- `worker/src/resources/opencode-config-builder.ts` 输入 `ExecutionConfig`，输出 `{ agentName: "policy-<epId>", permission: {...}, writePaths }` 形式的多 agent 声明片段 + 会话指定参数（不含 `if role` 分支）。
- `server/prisma` 的 `ExecutionPolicy.config` 即此片段的上游源（`permissions: Record<string,"allow"|"ask"|"deny">` + `writePaths: string[]`），`agents.policyId` 为唯一绑定键。
- `worker/src/protocol/worker-protocol.ts` 的 `executionConfig?: ExecutionConfig` 字段透传，下游由 builder 消费。

---

## 6. 风险与待运行时复核

- 运行时需实测 `prompt` 的 `agent` 字段在 `serve` 的实际参数名（`model`/`agent` 混用），Wave4 A3 翻译器需做参数名兼容（`agent` / `agentName` 二选一回退）。
- 若实测 `serve` 对 `.opencode.json` 有进程级缓存，则需在 `createSession` 后触发 `fsync` 或短延迟重读（Wave4 A3 兜底分支预留）。

---

*本报告基于当前代码静态分析与 omo 同源机制产出，已满足 Wave4 单通道选型所需的决策输入；运行时复核留 Wave4 A3 实测闭环。*
