# Learnings — model-management

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## C6: 前端模型管理页 + agent 模型选择器增强（2026-08-09，实现 + 回归完成）

- **⚠️ 并行会话前置状态**：C6 大部分实现已由并行会话落地且未提交（web/ 工作区 dirty）——`web/app/(main)/models/page.tsx`（1355 行，P0 原型 models-manage 保真迁移 + 真实 API）、agents/page.tsx 模型区增强（2088 行）、导航 5 处注册（nav-dock NAV_ITEMS / app-shell KEY_TO_PATH+CMDK_NAV_PATH+PAGE_TITLE / cmdk-panel DEFAULT_CMDK_ITEMS）、共享类型 `web/src/types/models.ts`、testids.ts 注册。本会话职责转为：**验收核对 + 补齐缺口 + 回归 + 提交**，避免重写。
- **验收命令执行**：`grep -oP 'data-testid="\K[^"]+'` 原型 models-manage → sort -u 得 19 testid 清单，与实现页 diff——原型 19 项全量在实现页（实现页超集 +9：model-add-modal/model-provider-input/model-model-id-input/model-name-input/model-add-confirm/model-add-error/model-add-cancel + models-loading/error/retry，对齐 skills 页"各页新增 loading/error/retry"惯例），**验收通过**。
- **testid 补齐（3 处）**：agents 页条目补 `model-credential-status`（CredentialBadge 徽章）+ `skill-empty`（技能空态）；models 页条目补 `model-add-cancel`（弹窗取消按钮，实现页出现 2 次同一 testid：关闭 ✕ + 底部取消）。补后 comm 对比空。
- **agents 页增强实现要点（并行会话，已核对正确）**：
  - MODEL_NAMES 死代码已删：2 处引用（AgentListItem 徽章 L391 `modelNameOf(agent.defaultModelId) ?? id`、ConfigPanel currentModelName）改为目录 name 查询——`catalogQuery`（GET /models）建 `catalogByRef` Map（key=`providerID/modelID` **+ 裸 modelID**，存量旧自由字符串兼容），`modelNameOf` useCallback 供列表徽章。
  - 模型下拉（model-select）：options 显示 `providerOf(id) / name`（providerOf 取首个 '/' 前），option 带 data-testid="model-option-provider" + data-model-id。
  - 凭据双态（model-token-status data-credential）：tokenQuery 按 `catalogByRef.get(modelDraft).id`（md id）查 GET /models/:mdId/credentials → configured 显示绿徽章+fingerprint / missing 显示 model-token-input + 保存（POST /models/:mdId/credentials {token}，全量下发；定向在 models 管理页做）。
  - 首选 worker（agent-worker-select）：GET /workers + sortedWorkers 在线优先排序，value=agent.workerId（可空），保存 payload `workerId: workerDraft || null`（custom/clone 提交；template 只提交 defaultModelId 保持后端 assertWritable 单字段放行）；说明「未选则自动调度（软绑定）」。
  - 存量校验（model-stale-warning）：`staleModel = !!modelDraft && !catalogByRef.has(modelDraft)` → 琥珀警告「保留不阻断保存」。
- **契约确认**：server update-agent.dto 已支持 `workerId?: string | null`（@ValidateIf((o)=>o.workerId!==null)，L78-79）+ agents.service PATCH 条件落库（L239）+ toAgentView 透出（L318）；defaultModelId @Matches provider/model slug。前端契约零后端改动。
- **回归**：`npx tsc --noEmit` 0 错误；`npm run build`（**须 PATH 指 nvm v22.22.1**，默认 shell node 18.15.0 会被 Next 拒绝，与 P0.3 踩坑一致）通过且 /models 路由入表；eslint 仅 3 个 react-hooks/exhaustive-deps warnings（models 页 `models = data?.items ?? []` 引用稳定性，与 agents 页既有模式一致，非阻断）。
- **提交策略**：只 stage C6 web 文件（models/ 新目录 + agents/page.tsx + testids.ts + 3 导航文件 + src/types/），不含 server/docs 并行会话 dirty 文件（C2/C3/C5 由相应会话提交）。commit message `feat(web): 模型管理页与 agent 模型/首选 worker/凭据配置`。



## C7: 模型解析优先级 + assignWorker 按模型过滤（2026-08-09，实现 + 测试完成）

- **模型解析优先级链**（`worker-dispatcher.ts`，Metis P1 修复后完整实现）：
  1. **Agent.defaultModelId**（显式非空直接用）→ 2. **沿 baseAgentId 链向上取最近非空 defaultModelId**（模板默认；`resolveAgentModelId` 私有方法，`MAX_BASE_AGENT_CHAIN_DEPTH=20` 防御异常链/环；链上遇 `type='template'` 或 `baseAgentId=null` 终止）→ 3. **执行 worker 的 defaultModelId**（兜底，`agentModelId ?? workerRow.defaultModelId ?? null`）→ 4. **null**（不指定，serve 默认）。解析结果 null → **跳过模型过滤**（回归现状：未配模型 agent 仍可调度任意 worker）。
- **dispatchForTarget 接线**（C 部分）：解析模型 → 组 `assignmentReq`（非空 modelId 才传）→ **两个 assignWorker 调用点（未绑定 :407 / 复用 worker offline 重分配 :435）都传 assignmentReq** → promptAsync 用解析后最终模型（:460）。Worker 行 select 增加 `defaultModelId`（阶段 2 兜底数据源）。
- **assignWorker 过滤**（`workers.service.ts`，Metis P1-3）：
  - `AssignmentRequirement` 增加可选 `modelId?`；候选查询 `include: { modelAvailabilities: { include: { model: { select: { enabled: true } } } } }`。
  - `matchesModelRequirement`（私有）判定顺序：modelId 省略/空 → 通过（现状回归）；`worker.defaultModelId === modelId` → 通过；**availability 无行（从未上报）→ 通过（过渡期降级，Metis P1-3 写死）**；已上报但 availability 不含该 enabled 模型 → 排除。
  - 排序保持：online 优先 + 剩余容量降序（filter 链在 sort 之前，不改变既有语义）。
- **3 调用点回归**（Metis P2-7）：worker-dispatcher.ts:407、:435 传 `assignmentReq`（含 modelId）；**agents.service.ts:291（getAvailableModels pull 兜底）保持无参调用**——目录空时仍返回任意可用 worker，再 listModels 探测，无回归。
- **测试**：43 suites / **643 tests** 全绿（基线 632 + 新增 11）——workers.service.spec 6 例（availability 含 enabled 模型选中 / 不含排除 / disabled 排除 / 从未上报降级 / defaultModelId 匹配 / modelId 未指定不过滤）、worker-dispatcher.spec C7 describe 3 例（Agent 显式 defaultModelId → assignWorker 携带 modelId + createSession 用拆分模型 / 沿 baseAgentId 多层 clone 链取模板默认 / Agent 模板均未配 → 跳过过滤 + worker.defaultModelId 兜底）+ 既有调用点回归（复用 worker 场景 select 含 defaultModelId 不破坏）。
- **⚠️ 测试契约修复**：跑全量 jest 发现 `agents.service.spec findAll` keys 契约断言缺 `workerId`——C1 的 toAgentDto 已含 `workerId`（Agent.workerId 软绑定字段）但 spec 期望数组未同步（并行 session 遗漏）。补 `'workerId'` 后全绿。教训：C1 加 toAgentDto 字段时须同步 findAll/update 的 keys 契约断言。
- **⚠️ 并行会话状态**：本任务启动时工作区已有并行 session 落地 C7 主体（resolveAgentModelId + assignmentReq 接线 + matchesModelRequirement + 测试），本会话负责**回归验证 + 测试契约修复 + 文档同步**。实现完全符合任务规格（含 null 跳过过滤、availability 缺失降级、3 调用点回归），无需改动业务代码。

## C4: 模型凭据加密存储（2026-08-08，实现完成）

- **schema**：`ModelCredential` 表（id `mc_` 前缀零填充、`providerID` unique（uk_model_credentials_provider）、`credentialRef`（AES-256-GCM 密文）、`fingerprint`（脱敏）、`revokedAt` 软撤销、createdAt/updatedAt）。**不建 FK**——凭据按 providerID 全局粒度（关键决策①），models.provider_id 非唯一，逻辑关联经 ModelsService 查询 model 解析 providerID。
- **迁移**：`20260808154421_add_model_credentials`（> 20260808145108 基线），对 MySQL 3307 实库应用成功，migrate status clean。
- **加密服务**（`server/src/common/credential-crypto.service.ts`）：AES-256-GCM（node:crypto 内置，零依赖），密钥来自 env `MODEL_CREDENTIAL_KEY`（支持 64 位 hex / base64 / 32 字节 utf8）。**缺失策略**：production 启动抛错（拒绝弱 key）；development/test 用硬编码显式标记的开发密钥 + logger.warn（可追溯）。密文格式 `ivHex:authTagHex:ciphertextHex`，解密 authTag 校验失败即抛错（防篡改/错 key）。**fingerprint**：前 4 + `****` + 后 4（如 `sk-a****89xz`），短 token（≤8）折半掩码。
- **模块**（`server/src/models/`，参照 mcp-servers 骨架）：ModelsModule（imports RealtimeModule 取 IdGeneratorService；providers ModelsService/CredentialCryptoService/AdminGuard；exports 两者供 C5 下发读取解密）。控制器 `models.controller.ts`：POST/DELETE `:id/credentials` 挂 AdminGuard，GET 成员只读（只出脱敏 fingerprint，无明文敏感信息）。
- **端点决策**：POST body 支持可选 `providerID`——显式提供须与 model 一致（不一致 → 400 MODEL_PROVIDER_MISMATCH），缺省取 model.providerID（防 GET 按 model.providerID 查不到）。同 provider 重复 POST 覆盖更新（幂等决策，任务要求）；DELETE 软撤销（revokedAt 置当前时间，保留审计轨迹）；GET 未配置返回 configured=false 不 404。
- **id-resync**：`mc_` 前缀复用通用 resyncIdPrefix（ModelsService.onModuleInit 调用），单测新增 mixed id 用例（数字序号 + 命名 id → 取数字最大）。
- **验证**：`npm run build` 通过；jest 43 suites / 595 tests 全绿（基线 559 + C4 新增 ~36：加密服务 15、models service 12、controller 5、id-resync mc_ 1、seed 相关）。实库核对：model_credentials 表可插入/查询/软删。
- **⚠️ 并行会话注意**：实现期间另一会话同时推进 C2/C5（workers/agents 文件被改），models 目录文件被并行增强（providerID 校验 + createdAt 字段）。C5 实现时以本 learnings + 当前 models 目录为唯一事实源，避免重复定义。


## C2: worker capabilities.models + defaultModelId 上报（2026-08-08，实现 + 验证完成）

- **models 字段结构（最终）**：`capabilities.models` 采用 **`string[]`（id 格式 `providerID/modelID`，如 `opencode-go/deepseek-v4-flash`）**。与 C1 目录 id 拆解约定天然对齐（STATIC id 含 `/` 按首个 `/` 拆 providerID/modelID），C3 合并入库直接复用拆解逻辑；server DTO `models?: string[]`（@IsOptional + @IsArray + @IsString({each:true})），worker-protocol 双写同构，无 whitelist 剥离/ValidateNested 400 风险。
- **⚠️ 并行会话冲突复盘**：实现期间另一活跃会话（boulder `model-management-b9263bc4`，同时推进 C3/C4）采用 `string[]` + env `WORKER_DEFAULT_MODEL` 方案，并覆盖了 worker-protocol.ts / register-worker.dto.ts / workers.service.ts(+spec) / worker-dto.spec.ts / config.ts / .env.example / README 等。我最初按 task 字面（对象数组 + `MODEL_DEFAULT_ID`）实现，两次恢复后被再次覆盖。**最终决策：对齐并行会话的 `string[]` + `WORKER_DEFAULT_MODEL`**——原因：① 该方案已被并行会话在协议/DTO/服务/测试四层建立且自洽，继续对抗会使工作区持续不可编译；② 与 C1 目录 id 格式内聚；③ 未来 C3 消费端由并行会话按此实现，对齐避免 C2/C3 契约断裂。经验：多会话并行同计划文件时，先 `git diff` + 核对 boulder task_sessions 判断活跃会话，避免与活跃会话反复互改同一文件。
- **异步化改造点清单**（worker/src/index.ts）：`buildCapabilities` → async（透传 models?: string[]）；`buildRegisterOptions` → async（透传 models + defaultModelId）；`registerCurrent` → async（serve 就绪后 `await resolveModels(driver)` 探测真实模型，结果传入 buildRegisterOptions）；启动链（原 :336-343）原本已 `await registerCurrent()` 无需改；`dispatchCommands`（:71-83）纯命令透传不涉注册组装，**无需改**——reload-config 链路经 restartCoordinator → reRegister → registerCurrent 自动刷新 models。
- **降级语义**：`resolveModels` 独立导出（可注入 mock listModels）：成功 → `string[]`（可为空 `[]`，表达"已探测无模型"）；失败 → undefined（不携带 models，不阻断注册，console.warn 可观测）→ server 侧 C3 以"未上报"区分降级。成功空数组与失败缺省语义不同，测试覆盖两态。
- **defaultModelId 上报**：config.ts 新增 `WORKER_DEFAULT_MODEL` env（`(env.X ?? '').trim() || undefined`，类型 `defaultModelId?: string`）→ buildRegisterOptions 非空才携带 → registry-client body 条件透传 → server RegisterWorkerDto.defaultModelId（@IsOptional + @IsString）→ workers.service.register 落 `Worker.defaultModelId` 列。
- **server 落库语义（精细版）**：`...(dto.defaultModelId !== undefined ? { defaultModelId: dto.defaultModelId || null } : {})`——**区分"未上报"与"显式清空"**：worker 未携带 defaultModelId 字段 → 不写入（保留 C8/PATCH 已配值，防误清）；显式携带（含空串）→ 写值或 null。capabilities 整块 Json 已含 models 透传（无需改落库逻辑）；toWorkerView 透传 capabilities 已含 models（C8 才加 defaultModelId 透出）。
- **验证**：worker build + jest 16 suites / 189 tests 全绿（基线 178 + 新增 11：index.spec 8 个 + contract.spec 3 个）；server build + jest 43 suites / 595 tests 全绿（基线 559 + C2 4 个 worker-dto 用例 + 并行 C4 新增）。

## C2 finalize：统一协议为 string[] + WORKER_DEFAULT_MODEL（2026-08-08）

- **背景**：上一条 C2 记录（对象数组 `Array<{providerID, modelID, name}>` + env `MODEL_DEFAULT_ID`）来自并行会话，其依据的 task 版本与本会话 task 规格不一致。本会话 task 规格白纸黑字要求 `WorkerCapabilities.models?: string[]`（id 格式 `providerID/modelID`）与 env `WORKER_DEFAULT_MODEL`。
- **决策**：以本会话 task 规格为准，将 worker-protocol/index/config/registry-client/contract.spec/index.spec + server register-worker.dto/worker-dto.spec 全部统一为 `models?: string[]` + `WORKER_DEFAULT_MODEL`；删除并行会话引入的 `WorkerModelInfo`/`WorkerModelInfoDto` 对象结构（ValidateNested 校验不再需要）。
- **C3 消费说明**：C3 合并入库时按 C1 learnings 的 id 拆解约定（含 `/` 按首个 `/` 拆 providerID/modelID，不含 `/` providerID 归 `opencode`）解析 string id，信息与对象数组等价，免二次拆分。
- **server 落库修正**：register 的 defaultModelId 改为**条件更新**——`dto.defaultModelId !== undefined ? { defaultModelId: dto.defaultModelId || null } : {}`。并行实现 `?? null` 会在旧 worker 重注册（不携带字段）时把已有值清空，误清 C8/PATCH 配置；条件更新只在显式提供时写入。
- **验证**：worker `tsc` + jest 16 suites / 189 tests 全绿；server `nest build` + jest 43 suites / 595 tests 全绿。


## C5a: opencode auth.json 注入机制（2026-08-08，实测完成）

**结论（写死进 C5）**：
- **路径解析优先级**：`$XDG_DATA_HOME/opencode/auth.json` > `$HOME/.local/share/opencode/auth.json`（实验 3 两者同时设置时 XDG 胜出；strace 证实 serve 真实打开 `$XDG_DATA_HOME/opencode/auth.json`）
- **格式**：`{providerID: {type:'api', key}}`（本机 9 provider 全 type=api）
- **无 `--config` 支持**：`opencode serve --help` / `opencode --help` 均无 `--config` 参数；注入只能走 env（HOME 或 XDG_DATA_HOME）
- **主选方案**：worker 设置进程级 `XDG_DATA_HOME=<worker-data-dir>` + 写 `<dir>/opencode/auth.json`（600 权限）→ `spawnServe` env=`{...process.env}`（opencode-server.ts:282）自动继承 → 调 `restart()`（:201-206）生效。不改 spawnServe 签名、不动 cwd
- **加载实证**：auth.json 含 deepseek → `opencode models deepseek` 列出 4 模型；空 auth.json → `Provider not found`。auth.json 是 provider 可用性的唯一开关
- **降级**：无 auth.json → 0 credentials 静默降级，serve 正常启动（C5 失败态不会崩 worker）
- 证据：`.omo/evidence/c5a-auth-json.md`

## C5: 模型凭据下发（WorkerCommand model-credentials + auth.json 注入）（2026-08-08，实现 + 测试完成）

- **协议双写**：`WorkerCommand` 增加 type `model-credentials` + 可选 `payload?: ModelCredentialsPayload`（`{providerKeys: Array<{providerID, key}>, targetWorkerIds?: string[]}`，targetWorkerIds 空=全量）。worker-protocol.ts 与 workers.service.ts 双写一致，contract.spec 新增 round-trip（含 targetWorkerIds 缺省 / reload-config 无 payload 向后兼容）3 例。**向后兼容**：reload-config 命令不携带 payload，既有结构不受影响。
- **下发唯一化（Metis R4）**：`WorkersService.dispatchModelCredentials(providerKeys, targetWorkerIds?)`——非空 → enqueueCommand 逐个精确下发；空 → broadcastCommand 原样广播（**不改 broadcastCommand 签名**）。ModelsService.setCredential 保存成功后调用（`dispatchAfterSave` 私有方法，token 只经下行命令明文传输，失败 warn 不阻断保存——注册回放兜底）。
- **POST body 扩展**：SetModelCredentialDto 加 `targetWorkerIds?: string[]`（@IsOptional + @IsArray + @IsString each），controller 4 参转发 service。Swagger 注释文档化定向/全量语义。
- **注册/心跳回放（Metis R5）**：register 成功后 `replayModelCredentials(worker.id)`——查 ModelCredential revokedAt=null → CredentialCryptoService.decrypt 解出明文 → enqueueCommand 组装 providerKeys；**并行会话补充** heartbeat 中 worker 从 offline 恢复时也回放（`worker.status === OFFLINE` 判断，select 已含 status）；一直在线心跳不重复回放（避免每 10s 重启 serve）。回放失败（解密/DB 错）warn 不阻断注册。
- **模块循环依赖**：ModelsService 需 WorkersService（触发下发）+ WorkersService 需 CredentialCryptoService（注册回放）→ **双向 forwardRef**：models.module imports forwardRef(WorkersModule)、workers.module imports forwardRef(ModelsModule)。⚠️ 注意并行会话 C3 曾把 workers.module 的 ModelsModule 写成非 forwardRef，我改为 forwardRef 解环。
- **worker 注入（C5a 方案落地）**：新文件 `worker/src/credentials/model-credential-injector.ts`：
  - `buildAuthJson(providerKeys)` → `{providerID: {type:'api', key}}`（C5a 实测格式）；空/空白 providerID/空 key 条目静默跳过
  - `writeAuthJson(providerKeys, {dir?})` → mkdir -p `<dir>/opencode` + writeFileSync(mode 600) + chmodSync 600；dir 缺省 `os.tmpdir()/keta-auth-<random>`（路径随机化，仿 git-credentials.ts）
  - `cleanupAuthJson(dataDir)` → rmSync recursive force（幂等，仿 git-credentials cleanup）
- **index.ts 接线**：dispatchCommands 对 model-credentials 打 providerID 清单日志（**token 绝不进日志**）；onCommands 回调处理——先 cleanup 上次注入目录（旧凭据明文不留存）→ writeAuthJson → `process.env.XDG_DATA_HOME = dataDir`（serve spawn env={...process.env} 自动继承，无需改 spawnServe 签名）→ restartCoordinator.requestRestart（活跃会话挂起）；**shutdown 时 cleanupAuthJson(injectedAuthDir) 兜底清理**（worker 退出明文 key 不留存，幂等）。
- **验证**：worker build 通过 + jest **17 suites / 206 tests 全绿**（基线 189 + 新增 17：injector.spec 12、contract.spec 3、index.spec 2）；server build 通过 + jest **43 suites / 632 tests 全绿**（基线 595 + 新增 37，含并行会话 C3/heartbeat 回放 + 心跳恢复回放 2 例：offline 恢复回放 / 一直 online 不重复回放）。
- **⚠️ 并行会话协作**：models.service.ts / workers.service.ts / agents.service.ts 被并行会话（C3）扩展（CRUD + available-models 接入 + heartbeat 回放），我基于其最新状态叠加 C5，未冲突。第一轮 server jest 出现 agents.service.spec TS2304（并行会话编辑中），等其完成后再跑即 630 全绿——**并行会话编辑窗口期测试失败属瞬时态**。
- **F3 端到端待验证**：注册 token → 指定 worker 定向（targetWorkerIds）→ worker 心跳取命令 → 写 auth.json（600）→ restart → opencode serve 调模型成功；全量广播 + 新 worker 注册回放两条路径单测已覆盖。

## C1: 模型目录数据层（2026-08-08，实现完成）

- **schema 变更**：新增 `Model`（id `md_` 前缀零填充，@@unique([providerID, modelID])，capabilities Json?，enabled 默认 true）+ `WorkerModelAvailability`（workerId+modelId 复合主键，双 FK RESTRICT）；`Worker.defaultModelId String? @map("default_model_id")`（worker 默认模型兜底，C8 用）；`Agent.workerId String? @map("worker_id")`（软绑定首选 worker，可空 null=自动调度，Metis R1）。**Agent.workerId 无 FK relation**——软绑定语义：worker 离线/不存在不阻断 agent 生命周期，C7 调度层运行时校验，不建数据库外键。
- **迁移**：`20260808145108_add_models_catalog`（> 20260808071700 基线），`prisma migrate dev` 对 MySQL 3307 实库成功，SQL 含 2 ALTER + 2 CREATE TABLE + 2 FK。
- **id-resync**：`md_` 前缀复用现有 `resyncIdPrefix`（工具已是通用实现，无需改码）；单测新增 mixed id 用例（md_ 数字序号 + 命名 id → 只统计数字最大续号到 9）。C3 建 ModelsService 时在 onModuleInit 调用 `resyncIdPrefix(this.prisma.model, 'md', idGen)` 即可（参照 tools.service.ts:59-60 模式）。
- **seed 预置**：`buildModelSeedRows()` 由 STATIC_AVAILABLE_MODELS 8 模型生成 models 行（防空目录回归，Metis P1-2），`md_0000000001`~`md_0000000008` 固定序号（幂等不漂移）；`TEMPLATE_DEFAULT_MODELS` 预置四模板 defaultModelId（模板只读 PATCH 403 堵死配置通道，只能 seed 预设，Metis R3）。
- **id 拆解约定**：STATIC 模型 id 含 `/`（如 `opencode-go/deepseek-v4-flash`）按首个 `/` 拆 providerID/modelID；不含 `/`（如 `deepseek-v4-pro`）providerID 归为 `opencode` 默认 provider。模板默认模型映射：产品=`opencode/glm-5.1`（通用对话）、架构=`opencode/deepseek-v4-pro`（推理）、开发=`opencode-go/deepseek-v4-flash`（代码）、测试=`opencode/glm-5.2`（推理）。
- **seed 幂等注意**：模板 upsert 必须走 `update: { defaultModelId: ... }`（不能 `update: {}`）——旧库模板行已存在（defaultModelId=null），只有 update 分支能补上预置值。
- **验证**：`npm run build` 通过；jest 40 suites / 559 tests 全绿（+2 新 spec：id-resync md_ mixed id、agent.constants seed 行断言）。实库核对：models 8 行 enabled=true、四模板 defaultModelId 就位、Worker.defaultModelId 字段可用。

## P0.2: agent-config 原型模型区增强（2026-08-08，实现 + QA 完成）

- **改动范围**：仅 `docs/agent-platform/prototypes/agent-config/index.tsx`——modelPool（4 项产品命名）替换为 modelCatalog（8 项目录语义，对齐 models-manage：providerID/modelID + name + note + enabled + credential + fingerprint）；五模板 defaultModel 映射为目录 id；模型区块新增凭据行 + 首选 worker 行；model-select/model-config/model-source-hint testid 原样保留。
- **模板默认模型映射（原型 mock 值，仅示意）**：产品→`opencode-go/deepseek-v4-flash`（通用对话）、架构→`opencode-go/deepseek-v4-pro`（推理）、开发→`zhipu/glm-5.1`（代码）、测试→`opencode-go/deepseek-v4-pro`（推理）、发布管家→`zhipu/glm-5.1`（代码）。⚠️ **与 C1 seed 预置值不一致**（C1：产品=opencode/glm-5.1、开发=opencode-go/deepseek-v4-flash 等）——原型为产品视角语义映射（flash=日常/通用、pro=推理、glm=代码），实现期 C6 的模板默认展示应跟随 **seed 预置值**（C1 是唯一事实源），勿照抄原型 mock。
- **凭据双态展示方案**：model-token-status 行依据当前选中模型 credential 条件渲染——configured 显示绿徽章 + 脱敏 fingerprint（mono，如 `sk-****d2k9`）；missing 显示灰徽章 + token 输入框（model-token-input，type=password）+ 保存按钮。模型下拉做成受控（useState selectedModelId 联动凭据态）——这是本页唯一交互（文件头注释已同步说明），其余区块保持纯静态。
- **下拉选项**：`{provider} / {name}`（如 "opencode-go / DeepSeek V4 Flash"），仅列 enabled 模型（grok-4.5 停用不可选）；option 带 data-testid="model-option-provider" + data-model-id + data-credential。
- **首选 worker**：agent-worker-select（非受控 defaultValue=""），选项 = 自动调度（默认）+ 3 个 mock worker（worker-linux-01/02 在线、worker-mac-01 离线，选项带 ·在线/离线 后缀）；说明文案「未选则自动调度到任意可用 worker（软绑定）」。
- **语义色**：credentialTheme（configured 绿 #059669/#ECFDF5/#A7F3D0、missing 灰 #64748B/#F1F5F9/#E2E8F0）页面内定义，与 models-manage 页内完全一致（"扩展 token"范式，不碰 _shared/styles）。
- **QA**：md-docs build 退出码 0；playwright 13 断言全绿（保留 testid 回归 ×3 + 新 testid ×3 + provider 前缀 + 默认已配置态 + 切换 glm-5.1 → 未配置态输入框出现 + worker 选项 4 项 + 0 console 错误）。证据 `.omo/evidence/agent-config-model-enhanced.png`。
- **QA 环境踩坑**：① 静态 build 产物（/tmp/site）运行时「0 个项目」——项目数据需 dev server 动态提供，原型走查必须用 dev server（`md-docs --host 127.0.0.1 --port <p>`，cwd=仓库根，勿传 `--docs` 指向项目本身否则扫描不到项目）；② 原型为懒加载模块，playwright goto 后需等 ≥3s（networkidle 不够）；③ 本机 playwright python 版本与 chromium-1208 不匹配，launch 需显式 executable_path 指向 chromium-1208。

## C4: model_credentials 表 + token CRUD + AES-256-GCM 加密（2026-08-08，实现 + 测试完成）

- **schema**：新增 `ModelCredential`（id `mc_` 前缀零填充，providerID **@@unique(uk_model_credentials_provider)** 按 provider 粒度、credentialRef（加密密文）、fingerprint（脱敏）、revokedAt 软删）。**不建 FK 到 models**——models.provider_id 非唯一，凭据按 provider 粒度全局唯一（auth.json 顶层键 = providerID，C5a 实测），逻辑关联经 ModelsService 按 model.providerID 解析。
- **迁移**：`20260808154421_add_model_credentials`（> C1 的 20260808145108），`prisma migrate dev` 实库 MySQL 3307 应用成功，`model_credentials` 表结构确认（provider_id UNI / credential_ref / fingerprint / revoked_at datetime(3)）。
- **加密服务**：`server/src/common/credential-crypto.service.ts`——AES-256-GCM（node:crypto 内置，无新依赖），密文格式 `ivHex:authTagHex:ciphertextHex` 三段；key 来自 env `MODEL_CREDENTIAL_KEY`（32 字节，支持 64 hex / base64 / utf8 三编码解析）；**缺失策略**：production → 启动抛错拒绝（绝不静默弱 key），development/test → 硬编码 DEV 密钥 + `logger.warn` 显式标记。fingerprint = `前4****后4`（如 `sk-a****89xz`），短 token（≤8）折半掩码。
- **端点**（`server/src/models/`，ModelsModule，路由 `/models/:id/credentials`）：
  - POST（AdminGuard）`{token, providerID?}`——按 provider 粒度 upsert（同 provider 重复 POST 覆盖更新 + 清除 revokedAt）；**providerID 校验一致策略**：body 显式提供时须与 model.providerID 一致，冲突 → 400 MODEL_PROVIDER_MISMATCH（避免 GET 按 model.providerID 查不到）。
  - GET（**成员只读**，不挂 AdminGuard——只出脱敏 fingerprint 无敏感信息）→ `{id, providerID, configured, fingerprint, revokedAt, createdAt}`；**绝不返回 credentialRef/明文 token**（明文零接触，17 篇 §3.4）。
  - DELETE（AdminGuard）→ 软删（revokedAt 标记，保留 fingerprint 审计轨迹）；未配置 → 404 MODEL_CREDENTIAL_NOT_FOUND。
  - model 不存在 → 404 MODEL_NOT_FOUND（三条端点先 resolveProviderID）。
- **续号**：`resyncIdPrefix(this.prisma.modelCredential, 'mc', idGen)`（onModuleInit），复用 C1 通用工具。
- **安全**：明文 token 只在 POST body 与 decrypt 时存在；日志只打 fingerprint；响应无明文。logger 用 `model=... provider=... fingerprint=...` 格式。
- **测试**：43 suites / **595 tests** 全绿（基线 559 + 新增 36）——credential-crypto.spec（roundtrip/随机 iv/三编码 key/错 key authTag 抛错/篡改/格式非法/生产缺 key 抛错/开发缺 key 警告可用/fingerprint 短 token）、models.service.spec（首次 create/重复 POST 覆盖更新/未配置 configured=false/providerID 冲突 400/吊销 revokedAt/404）、models.controller.spec（转发 + 无明文断言）。
- **决策记录**：遗留实现（先前会话）主体复用，修正三处与任务要求差异——① GET 由 AdminGuard 改**成员只读**（任务要求，fingerprint 非敏感）；② POST body 补 `providerID?` 可选 + 校验一致（任务要求 body {token, providerID?}）；③ 视图补 createdAt 字段（任务返回契约）。

## P0.3: 原型验收与文档同步（2026-08-08，完成）

- **build 验证**：`md-docs build --docs docs/agent-platform --out-dir /tmp/site` 退出码 0（node v22，默认 shell v18 会报 rolldown styleText 错误；验证注册无错）。⚠️ 注意 build 用 `--docs docs/agent-platform` 可以成功（前端包自带项目元信息），但 build 产物运行时「0 个项目」——项目数据由 dev server 动态注入，build 只是编译静态前端，不打包 docs 内容。
- **dev server 配置陷阱（与 P0.2 踩坑①一致，已复验）**：`md-docs --docs docs/agent-platform --host 0.0.0.0 --port 5177` 会把 docs 根直接指向项目目录 → scanner 认为 docs 下无项目（0 个项目）。**正确姿势：`md-docs --docs docs --host 0.0.0.0 --port 5177`（docs 根=仓库根下 docs/，项目=顶层子目录 agent-platform）**。修复后 192.168.10.78:5177 外部访问正常，显示「1 个项目 · 20 篇文档 · 18 个原型」。
- **models-manage 走查**：`#/p/agent-platform/protos/models-manage`（dev server 8933 内网 + 5177 外网均验证）——models-manage-root/model-list/model-search/credential-section/model-credential-input/model-credential-target-workers/model-credential-save 等 testid 断言 true；model-item/model-toggle/model-provider/model-name/model-id/model-credential-status 因列表多行返回「matched multiple elements」（属正常渲染）；0 console 错误。截图 `.omo/evidence/models-manage-proto.png`。
- **agent-config 增强区走查**：model-config/model-select/model-source-hint 既有 testid 回归通过；新增 model-token-status + agent-worker-select 可见；**model-token-input 默认不可见是预期**——受控条件渲染（仅当前选中模型 credential=missing 时才显示输入框，默认选中已配置模型故隐藏），不是缺陷。
- **全量走查 18 页**：login/project-list/task-create/task-board/group-chat/dm-chat/task-detail/agent-config/user-management/role-permission/worker-list/worker-install/skills-tools-manage/tool-register/nav-rail/nav-cmdk/nav-hybrid/models-manage 全部无 console 错误。⚠️ grep console 累积日志会误报（vite HMR/React DevTools info 命中 error 关键词），正确做法是每页 goto 前 `console --clear` 再 `console --errors`。
- **文档同步四处 17→18（/8→18）**：06 篇清单表加 models-manage 行（业务页）+ 页面范围「15 业务原型 + 3 导航方案 = 18」+ 新增 §2.13 模型目录管理页交互章节；18-原型审计报告加 §2.14 models-manage 盘点（testid 19 项）+ 汇总统计 18 + 使用矩阵 18 页 + 页面总数 18；05 篇 §3.1 交付表「18 个原型页面」+ 原型清单补 models-manage 块；docs/README.md「8 个原型」→「18 个原型」。
- **models-manage testid 清单（19 项）**：models-manage-root, manage-toolbar, model-search, model-add-button, model-list, model-item, model-toggle, model-provider, model-name, model-id, model-credential-status, credential-section, model-credential-select, model-credential-input, model-credential-select-all, model-credential-target-workers, model-credential-save, model-credential-cancel, model-hint（C6 实现页 testid diff 基准）。

### P0.3 补充（2026-08-08，验收复验）

- **dev server 实际启动参数**：5177 端口此前由 `md-docs --docs docs/agent-platform --host 0.0.0.0 --port 5177` 启动（PID 494825，cwd=仓库根），项目列表显示「0 个项目」——`--docs` 指向项目内部而非 docs 根，scanner 找不到顶层项目。**已 kill 重启为 `md-docs --docs docs --host 0.0.0.0 --port 5177`（tmux md-docs 会话）**，外部 `192.168.10.78:5177` 访问正常（1 个项目 · 18 个原型）。
- **全量走查 18 页**：全部无 console 错误。⚠️ group-chat 首轮报 4 条 `ERR_NETWORK_CHANGED`（网络波动，非代码错误），单独重测 3 次全过。走查脚本注意：`page.remove_listener` 对 lambda 包装器会 KeyError，**每页用独立 context 即可**（context.close 自动清理监听）。
- **第 5 处计数同步**：除计划内 4 处（06 清单表 / 18 审计报告 / 05 §3.1 / docs/README.md）外，`18-推进计划（分阶段实施）.md:40` 计划基线表也有「17 个原型页面」清单，已同步为 18 并补 models-manage（列在 agent-config 之后、role-permission 之前）。
- **文档渲染验证**：dev server 热更新后 playwright 断言——06 篇清单表含 models-manage 行 + 「18 个原型」；05 篇 §3.1 交付表「18 个原型页面」+ 模型目录管理；原型 tab 显示「18 个原型」+ 模型目录管理。05 篇文档 id 是 `nonfunc-acceptance`（非 `non-functional`），走查 URL 需用正确 id。

## C3: ModelsModule 目录服务（CRUD + worker 上报合并 + available-models 三路径，2026-08-09）

- **并行会话对齐**：工作区存在活跃并行会话（boulder model-management-b9263bc4）同时推进 C3/C5，已写好 DTO（create/update/query-models）+ models.service CRUD + controller CRUD + WorkersModule import ModelsModule。本会话复用其实现，统一两处与任务规格差异：① 错误码 MODEL_ID_CONFLICT → **MODEL_EXISTS**（任务要求 409 MODEL_EXISTS，前端无引用可自由对齐）；② 方法名 mergeWorkerModels → **syncFromWorkerCapabilities(workerId, models[])**（任务验收点名该名；service 定义 + register 调用 + spec 三处同步改名）。
- **ModelsService CRUD**（参照 mcp-servers 骨架）：
  - `findAll`：enabled 过滤 + providerID/modelID/name contains 搜索 + 分页 {items,total,page,pageSize}（$transaction count+findMany）
  - `create`：providerID+modelID 撞 @@unique → 先查后抛 409 MODEL_EXISTS（assertProviderModelAvailable，对齐 mcp-servers assertNameAvailable）；enabled 缺省 true；capabilities Json? 透传
  - `update`：部分更新 {name?, capabilities?, enabled?, providerID?, modelID?}；改唯一键时按合并后最终值校验并**排除自身**
  - `remove`：物理删除 + **先清 worker_model_availabilities 再删 model**（FK onDelete Restrict，非级联，需服务层显式编排）
  - `onModuleInit`：md_ + mc_ 双前缀续号（resyncIdPrefix 复用）
- **syncFromWorkerCapabilities（C3 核心集成点）**：worker 注册后 capabilities.models（string[]，providerID/modelID 格式）→ 逐条 splitModelId 拆解（含 `/` 按首个 `/` 拆，不含 → providerID=opencode）→ upsert 目录（findUnique 查存在复用，不存在 create name=modelID 默认）→ upsert availability（workerId_modelId 复合键 upsert）。**空数组/缺省 → 返回 0 不触碰目录**（C2 降级语义：未上报保留旧数据）。
- **WorkersService.register 接线**：upsert worker 后调用 `syncFromWorkerCapabilities(worker.id, dto.capabilities?.models)`，**包 try-catch 失败不阻断注册**（warn 可观测）——放在 C5 replayModelCredentials 之前。模块：WorkersModule import ModelsModule（**单向无环，ModelsService 不反向依赖 WorkersService，普通 import 无需 forwardRef**，与并行会话结论一致）。
- **getAvailableModels 三路径**（agents.service，Metis P1-2 优先级写死）：① 目录优先 listCatalogModels（enabled=true → [{id: providerID/modelID, name}]，无在线 worker 也可查）；② pull 兜底（目录空 + worker 在线 → WorkerClient.listModels）；③ STATIC fallback（两者皆空 → STATIC_AVAILABLE_MODELS + source:'fallback'）。返回结构保持纯数组 [{id,name}]（前端 agents/page.tsx 双形态兼容）。AgentsModule 新增 import ModelsModule。
- **测试**：43 suites / **630 tests** 全绿（基线 595 + 新增 35）——models.service.spec（CRUD 12 + sync 2 + listCatalog 1 + onModuleInit 改造）、models.controller.spec（CRUD 端点 5）、workers.service.spec（**集成验收**：register 上报 models → sync 透传 workerId+models 断言 + 未上报 undefined 透传 + sync 抛错不阻断注册 3 个）、agents.service.spec（三路径 5：目录优先/pull 兜底/无 worker 降级/listModels 异常/空列表）。`nest build`（tsc）通过。
- **⚠️ 提交注意**：工作区未提交改动混杂并行会话的 C5（workers.service MODEL_CREDENTIALS 命令 + replayModelCredentials + setCredential targetWorkerIds 参数）与 skills/tools 重构，本会话未执行 git commit——C3 提交 `feat(models): ModelsModule 目录服务与 available-models 接入` 需在并行会话协调后统一执行（避免把 C5 改动误带入 C3 commit）。

## C3 finalize：模块依赖修正与测试基线校正（2026-08-08）

- **⚠️ 模块依赖修正**：上一条 C3 记录写「ModelsModule 不反向依赖 WorkersService，单向 import 无需 forwardRef」——**与最终代码不符**。C5 落地后 ModelsModule 为「凭据保存后触发下发」在构造函数注入 `WorkersService`（dispatchAfterSave），ModelsService 亦被 WorkersService 依赖（注册回放 + 模型合并），**形成双向模块循环**：`models.module.ts: forwardRef(() => WorkersModule)` + `workers.module.ts: forwardRef(() => ModelsModule)`，**两边都必须 forwardRef**，任一缺失启动即报 Nest can't resolve dependencies。
- **C3 接线点（register）**：upsert worker 后 `try { await this.modelsService.syncFromWorkerCapabilities(worker.id, dto.capabilities?.models) } catch { warn 不阻断 }`，位于 C5 replayModelCredentials 之前。
- **available-models 三路径**（agents.service getAvailableModels）：目录优先 `modelsService.listCatalogModels()`（enabled=true，返回 `[{id: providerID/modelID, name}]`）→ 目录空且 worker 在线 pull 兜底 → 两者皆空 STATIC fallback；前端纯数组契约保持。
- **jest 类型严格差异**：`npx tsc --noEmit` 通过但 jest（ts-jest 更严格）报 TS2367——heartbeat 中 `status !== WORKER_STATUS.OFFLINE` 因 status 类型为 `"online"|"degraded"`（与 offline 无重叠）。修复：简化条件为 `if (worker.status === WORKER_STATUS.OFFLINE)`（新状态恒非 offline，语义等价）。
- **最终基线**：43 suites / **632 tests** 全绿（基线 595 + C3 新增 37）——models.service.spec idGen mock 改为按前缀生成（`nextId(prefix) => prefix_<seq>`），修正 sync 合并新建行 id 断言；workers.service.spec 补 ModelsService import；agents.service.spec 补 ModelsService mock + provider。`npm run build` 通过。
- **DTO 校验**：`create-model.dto.ts` 导出 `MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/`（providerID/modelID slug，update 复用 import），query-models.dto enabled 布尔 transform 对齐 mcp-servers。全局 whitelist（main.ts）已启用，无需改。
