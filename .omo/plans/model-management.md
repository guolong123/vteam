# model-management - Work Plan

## TL;DR (For humans)

**交付**：为 AI Agents 平台实现「模型管理与使用」完整闭环——模型目录中心化 + 模型凭据管理下发（支持指定 worker）+ 前端模型管理页 + worker 默认模型兜底 + agent 首选 worker 软绑定，并让 worker 详情页显示可用模型、agent 模型选择支持已有模型且显示 provider（非仅名称）。

**为什么要这么做**：当前模型无集中维护（defaultModelId 自由字符串、列表靠 worker 实时 pull + 硬编码兜底、跨 worker 不一致、容器 worker 零凭据配置调不了模型）。按你确认的决策做成可维护、可复用、可实际调用模型的完整能力，并解决"切换到其他 worker 不知用什么模型"的问题。

**它不会做什么**：不做模型推理/转发（仍由 opencode serve 完成）、不做 agent 硬绑定 worker（软绑定，离线自动回退）、不删 server 兜底、不改 opencode serve 本身、不动其余 16 个原型页。

**工作量**：12 个实现 todo（P0 原型 3 + C1-C8 实现 9）+ 4 个最终验证波（F1-F4）。关键路径 P0 → C6 前端 → F3 端到端。

**风险**：凭据下发方案已通过前置实测（C5a）规避 env 变量名映射不可行问题；数据迁移通过 seed 预置防空目录回归；调度通过 availability 缺失降级保过渡期兼容；模板默认模型通过 seed 预置（模板只读规则堵死 PATCH 配置通道）。

**关键决策**：① token 全局 provider 粒度 + 凭据可指定 worker 定向下发（enqueueCommand）；② 凭据经 auth.json 注入（opencode 原生通道）；③ 模型解析优先级 Agent→模板（baseAgentId 链）→worker 默认→null（跳过过滤）→serve 默认；④ 模型选择器/详情卡显示 provider+模型名；⑤ agent 首选 worker 软绑定（agent.workerId 可空，离线自动回退）；⑥ 调度按模型可用过滤（availability 缺失降级，缺口⑤落地）。

## Scope

**IN（本计划交付）**：
- P0 原型先行：模型目录管理原型页（models-manage）+ agent-config 原型模型区增强（凭据/token 输入 + provider 显示 + 首选 worker）
- C1 models 表 + worker↔model 可用性映射 + **Worker.defaultModelId** + 迁移 + seed 预置（源自 STATIC_AVAILABLE_MODELS）
- C2 worker capabilities.models 注册/reRegister 上报（异步化全部调用点）+ **worker defaultModelId 上报**
- C3 ModelsModule（CRUD + AdminGuard + worker 上报合并入库 + available-models 改读目录 + 集成验收）
- C4 ModelCredential 表（provider token AES-256-GCM 加密存储 + fingerprint 脱敏）
- C5 凭据下发：auth.json 主选 + env 白名单；WorkerCommand 扩展 + 双端同步；**支持指定 worker 定向（enqueueCommand）+ 默认全量（broadcast）**
- C6 前端模型管理页 + agent 页模型选择器（目录拉取 + provider 显示 + 首选 worker 软绑定 + token 输入 + 校验）
- C7 分派模型解析优先级（Agent→模板→worker 默认→fallback）+ assignWorker 按模型可用过滤
- C8 worker 默认模型配置（管理 API + worker 详情页默认模型标识 + 模型解析接入）

**OUT（范围外，MUST NOT）**：
- 不做模型推理/转发（模型调用仍由 worker 的 opencode serve 完成）
- **不做 agent 硬绑定 worker**（软绑定：首选 worker 离线自动回退 assignWorker，不瘫痪）
- 不删 server 侧 STATIC_AVAILABLE_MODELS（保留为最终 fallback 源）
- 不改 opencode serve 本身（凭据经 auth.json/env 注入，不 patch opencode）
- 不动其余 16 个原型页（agent-config 仅做模型区增强）
- 不实现模型定价/限额/用量统计
- 不做自定义 provider 的 env 注入（env 白名单仅覆盖已映射 provider；未知 provider 走 auth.json）

## Verification strategy

- **测试策略**：tests-after（用户确认）——每个实现 todo 含对应测试，server jest 550 基线、worker jest 178 基线（实测值）
- **原型验收**：`md-docs build --out-dir /tmp/site` 退出码 0 + playwright 走查 `#/p/agent-platform/protos/<id>` 无 console 错误 + data-testid 断言 + 截图存档 `.omo/evidence/`
- **一致性验收**（18 篇 §3.1）：实现页 testid 与原型全量一致——验收命令「从原型 index.tsx grep `data-testid` 生成清单 → 与实现页 grep 结果 diff 为空」；新 testid 同步注册 `web/e2e/reference/testids.ts`
- **端到端实证**：compose 环境 13000/13001——注册 provider token → 指定 worker 下发 → worker 重启 → opencode serve 实际调用模型成功；无 token 时降级失败态正确
- **凭据安全**：AES-256-GCM 加密落库（17 篇 §3.4 基线）、token 不进日志/响应（fingerprint 脱敏）、auth.json 文件权限 600 + 路径随机化（17 篇 §5.4）
- **provider 显示**：前端所有模型展示处（agent 选择器 / worker 详情卡 / 模型管理页）均显示 provider + 模型名，非仅名称
- **模型解析**：Agent 未显式配模型 → 用执行 worker 默认模型 → 无 → STATIC fallback（分派单测覆盖优先级链）

## Execution strategy

```
P0（原型先行，独立可验收）
  ├─ P0.1 models-manage 原型页（仿 skills-tools-manage，含 provider 列）
  ├─ P0.2 agent-config 原型模型区增强（token 输入 + provider 显示 + 首选 worker）
  └─ P0.3 md-docs 注册 + playwright 走查 + build + 文档同步（06/18/README）

C1（models 表 + Worker.defaultModelId + seed 预置）→ C2（worker 上报）→ C3（ModelsModule + 集成验收）
C4（凭据表，可并行 C1）
C5a（auth.json 可行性实测，前置）→ C5（凭据下发含定向，依赖 C4 + spawnServe 注入点）
C6（前端，依赖 P0 原型 + C3 + C4 API）
C7（分派模型解析 + assignWorker 过滤，依赖 C3 + C2）
C8（worker 默认模型配置，依赖 C1 + C7）

F1-F4（最终验证波，全部实现后）
```

- 并行：C1 ∥ C4 ∥ P0；C5a 可在 C4 后即开；C7 ∥ C8（C8 依赖 C7 的解析链路但可先做配置 API）
- 关键路径：P0 → C6（前端对齐原型）→ F3（真实环境 QA）

## Todos

### Wave 1 - P0 原型先行

- [x] 1. 新建原型页 `docs/agent-platform/prototypes/models-manage/index.tsx`（模型目录管理，仿 skills-tools-manage 列表+Tab 组织，含 provider 列 + 凭据状态）
      - References: `docs/agent-platform/prototypes/skills-tools-manage/index.tsx`（组织范式 :1-32, 68-93, 1423-1435）、`docs/agent-platform/prototypes/_shared/styles.ts`（token 102 行）、`docs/agent-platform/prototypes/_shared/nav.tsx`（NAV_ITEMS :47-54）、`docs/agent-platform/prototypes/_shared/components.tsx`、`docs/agent-platform/prototypes/tool-register/index.tsx:1941-1953`（PrototypeDef 导出含 meta.group）、`/home/keta/.nvm/.../md-docs/src/prototypes/types.ts:41-59`
      - Acceptance: 默认导出 PrototypeDef（meta.id="models-manage"、meta.group="平台"、device="desktop"）；页面含模型列表（**provider 列 + 模型名称列 + 模型ID列** + 可用节点 + **凭据状态（已配置/未配置）** + 启用停用）+ 搜索 + 添加入口 + **凭据配置区（token 输入 + 目标 worker 选择）**；root height:100%+minHeight:720+position:relative 零 fixed/vh/vw（T15）；CmdKPanel 受控默认关闭（T20）；data-testid 齐备（model-list/model-item/model-search/model-toggle/model-provider/model-credential-*）
      - QA: happy——playwright 访问 `#/p/agent-platform/protos/models-manage` 断言关键 testid + 无 console 错误（证据 .omo/evidence/models-manage-proto.png）；failure——`md-docs build --out-dir /tmp/site` 退出码 0 验证注册无错
      - Commit: `feat(prototype): models-manage 模型目录管理原型页`

- [x] 2. 增强 `docs/agent-platform/prototypes/agent-config/index.tsx` 模型区（凭据/token 输入 + provider 显示 + **首选 worker 选择**，保持 model-* testid 前缀）
      - References: `docs/agent-platform/prototypes/agent-config/index.tsx:487-570`（现有 model-config/model-select/model-source-hint）、`docs/agent-platform/14-Agent配置与虚拟团队模型.md:124-133`（FR-47）、`:158-161`（四模板默认模型）
      - Acceptance: model-config 区块新增凭据行（model-token-input/model-token-status）mock 已配置/未配置态；**模型下拉选项显示「provider / 模型名」格式**；**新增首选 worker 选择（agent-worker-select，可选，说明"未选则自动调度"）**；四模板默认模型保留；既有 model-select 的 testid 不变
      - QA: happy——playwright 断言新 testid 可见 + 选项含 provider 前缀 + worker 选择可见；failure——既有 model-select 断言仍通过（回归）
      - Commit: `feat(prototype): agent-config 模型区补凭据/首选 worker/provider 显示`

- [x] 3. 原型验收：md-docs 注册 + 全量走查 + 文档同步
      - References: `docs/agent-platform/06-交互与页面设计.md:17-34`（页面清单）、`docs/agent-platform/18-原型审计报告.md`、`.omo/evidence/prototype-audit.md`、`docs/README.md:6`（原型计数已过时）、`/home/keta/.config/opencode/skills/md-docs/SKILL.md:128-159`
      - Acceptance: `md-docs build --out-dir /tmp/site` 退出码 0；`#/p/agent-platform/protos/models-manage` 可访问；18 页无 console 错误走查；**06 篇清单表 + 18 审计报告页面计数 + 05 篇（:75 计数 17）+ docs/README.md（:6 现为"8 个原型"严重过时）四处同步为 18**，并定义 models-manage 类别归属（业务页）
      - QA: happy——curl 原型注册含 models-manage；failure——page.on('console') 0 错误
      - Commit: `docs(prototype): 模型管理原型验收与文档同步`

### Wave 2 - C1/C2/C3 模型目录

- [x] 4. C1 数据层：`models` 表 + `worker_model_availabilities` 映射表 + **Worker.defaultModelId** + 迁移 + 续号 + seed 预置
      - References: `server/prisma/schema.prisma:285`（现状 Agent.defaultModelId）、`:392`（Worker 模型加 defaultModelId）、`server/src/mcp-servers/mcp-servers.service.ts:60-75`（onModuleInit 续号）、`server/src/common/id-resync.ts`（resyncIdPrefix 通用续号）、`server/src/common/constants/agent.constants.ts:25-34`（STATIC_AVAILABLE_MODELS 8 模型作 seed 源）、`docs/agent-platform/14-Agent配置与虚拟团队模型.md:420`（缺口⑤）
      - Acceptance: schema 新增 `Model`（id `md_` 前缀、providerID、modelID、name、capabilities Json?、enabled）+ `WorkerModelAvailability`（workerId+modelId 复合主键）+ **Worker 加 defaultModelId String?** + **Agent 加 workerId String?（软绑定首选 worker，可空，null=自动调度，schema.prisma:278-303）**；**迁移时间戳 > 20260808071700**；`prisma migrate dev` 成功；**seed 用 STATIC_AVAILABLE_MODELS 8 模型预置目录（enabled=true，防空目录回归）+ seed 预置四类模板（a_product/a_architect/a_developer/a_tester）的 defaultModelId（模板只读规则 PATCH 403 堵死配置通道，见 agents.service.ts:432-439，只能 seed 预设）**；id-resync 接入 `md_` 前缀
      - QA: happy——migrate status clean + 插入/查询 roundtrip（tsx 脚本）+ seed 后目录 8 行 + Worker.defaultModelId 读写；failure——id 冲突（resync 正确处理 mixed id）
      - Commit: `feat(models): Model/WorkerModelAvailability 表 + Worker.defaultModelId + 迁移 + seed`

- [x] 5. C2 worker 上报：`capabilities.models` 注册/reRegister 携带真实模型列表 + **defaultModelId 上报**（异步化全部调用点）
      - References: `worker/src/driver/v1-driver.ts:221-233`（listModels）、`worker/src/index.ts:108-122`（buildCapabilities）、`:130-145`（buildRegisterOptions）、`:198-211`（registerCurrent）、`:71-83`（dispatchCommands 透传）、`:336-343`（启动链）、`server/src/workers/dto/register-worker.dto.ts:14-40`（WorkerCapabilitiesDto，**whitelist:true 必须同步**）、`server/src/main.ts:16-19`、`worker/src/protocol/worker-protocol.ts:30-44`（双写）、`worker/src/protocol/contract.spec.ts:17-64`
      - Acceptance: buildCapabilities + buildRegisterOptions **异步化**（serve 就绪后 await listModels，失败降级不带 models）；**列出并修改全部调用点**（registerCurrent/dispatchCommands/启动链）；WorkerCapabilitiesDto 加可选 `models`（@IsOptional + 结构校验）+ **RegisterWorkerDto 加可选 defaultModelId**；worker-protocol.ts 双写；contract.spec + worker-dto.spec 补字段用例；reload-config reRegister 刷新
      - QA: happy——worker 注册后 GET /workers 的 capabilities.models 含真实模型（如 opencode/deepseek-v4-flash-free）；failure——listModels 失败时 models 缺省不报错
      - Commit: `feat(worker): capabilities.models 与 defaultModelId 上报`

- [x] 6. C3 目录服务：ModelsModule（CRUD + AdminGuard + worker 上报合并 + available-models 改读目录 + 集成验收）
      - References: `server/src/mcp-servers/mcp-servers.module.ts`（模块骨架）、`server/src/mcp-servers/mcp-servers.controller.ts:58-91`（GET 成员只读/写 AdminGuard）、`server/src/mcp-servers/mcp-servers.service.ts`（CRUD+校验）、`server/src/agents/agents.service.ts:282-297`（getAvailableModels 改读目录）、`server/src/common/constants/agent.constants.ts:25-34`（STATIC 兜底）
      - Acceptance: GET /models（成员只读，enabled 过滤）、POST/PATCH/DELETE /models（AdminGuard）；**worker 上报 capabilities.models 合并入库（upsert by providerID/modelID）——集成验收：mock worker 注册上报 models → 断言目录出现对应行**；GET /agents/:id/available-models 改读目录（enabled=true）+ **pull 兜底优先级写死：目录非空→读目录；目录空且 worker 在线→pull worker 上报；两者皆空→STATIC fallback**；DTO 全 optional + @IsOptional + providerID/modelID 格式校验
      - QA: happy——worker 上报 → 目录出现行 → available-models 返回目录模型；failure——非 admin POST /models → 403；目录空 + worker 离线 → STATIC fallback
      - Commit: `feat(models): ModelsModule 目录服务与 available-models 接入`

### Wave 3 - C4/C5 凭据管理与下发

- [x] 7. C4 凭据存储：`model_credentials` 表 + token CRUD + AES-256-GCM 加密
      - References: `docs/agent-platform/17-仓库权限与凭证机制.md:90-110`（credentials 表设计）、`:145-150`（安全基线 AES-256-GCM + fingerprint 脱敏）、`server/src/workers/worker-or-jwt.guard.ts`（token 处理模式）、`server/prisma/schema.prisma`
      - Acceptance: `ModelCredential` 表（id、providerID unique、credentialRef（加密引用）、fingerprint、revokedAt）；加密/解密服务（AES-256-GCM，key 来自 env `MODEL_CREDENTIAL_KEY`，缺失时启动警告 + dev key 显式标记）；POST/GET(脱敏 fingerprint)/DELETE /models/:id/credentials；fingerprint 响应脱敏
      - QA: happy——存 token → 读回 fingerprint → 解密 roundtrip；failure——无 key 时启动警告但可用 dev key；DELETE 后 revokedAt 标记
      - Commit: `feat(models): ModelCredential 加密存储与 token CRUD`

- [x] 8. C5a 前置实测：opencode auth.json 精确路径/格式/自定义路径支持验证
      - References: `/home/keta/.local/share/opencode/auth.json`（本机实测格式 {providerID:{type:'api',key}}）、`worker/src/runtime/opencode-server.ts:272-302`（spawnServe env/cwd）、opencode CLI 文档（`opencode auth login`）
      - Acceptance: 实测 auth.json 读取路径（$XDG_DATA_HOME 或 $HOME/.local/share/opencode/）；验证是否可用 `--config` 或 `HOME` env 指向 worker 自定义 auth.json；**结论写死进 C5**：主选 auth.json 写 worker 可写路径 + HOME 覆盖，或 serve 参数指定；记录实测命令与输出到 .omo/evidence/
      - QA: happy——复制 auth.json 到 worker 目录 + 启动 serve → 模型可用；failure——无 auth.json → 模型列表降级
      - Commit: `chore(worker): auth.json 注入可行性实测记录`

- [x] 9. C5 凭据下发：WorkerCommand 扩展 `model-credentials` + worker 注入 auth.json/env + **支持指定 worker 定向**（双端同步）
      - References: `worker/src/protocol/worker-protocol.ts:93-97`（WorkerCommand）、`server/src/workers/workers.service.ts:48-65`（**server 侧 WorkerCommand 双写定义**）、`:214-218`（enqueueCommand 精确 workerId）、`:227-236`（broadcastCommand 全量）、`worker/src/protocol/contract.spec.ts:112-122`（WorkerCommand round-trip 测试扩展）、`worker/src/index.ts:243-264`（下行命令处理）、`worker/src/runtime/opencode-server.ts:272-302`（spawnServe :282-285 env + restart :201-206）、`worker/src/git/git-credentials.ts:74-97`（临时文件 600 + cleanup 先例）、`docs/agent-platform/17-仓库权限与凭证机制.md:361-370`（清理触发）
      - Acceptance: WorkerCommand 加 `model-credentials` type（payload providerKeys[] + **可选 targetWorkerIds[]，空=全量**），**server 侧 workers.service.ts:48-65 与 worker 侧 worker-protocol.ts:93-97 双端同步 + contract.spec 扩展 round-trip 用例**；**下发定向实现唯一化：targetWorkerIds 非空 → enqueueCommand（:214-218）逐个精确下发；空 → broadcastCommand（:227-236）原样全量——不改 broadcastCommand 签名（空=全量无需过滤，定向走 enqueueCommand）**；**新 worker 注册/心跳时服务端回放全部未吊销凭据（补凭据保存后新注册 worker 缺凭据的缺口，见 R5）**；server 保存凭据后下发（含目标 worker）；worker 解析 → **写 auth.json（权限 600 + 路径随机化，先例 git-credentials.ts:74-97；17 篇 §5.4 是"凭证不进模型上下文"隔离原则，非 auth.json 依据）→ spawnServe 启动时经 HOME/--config 生效 → restart()**；env 注入仅白名单已映射 provider；restart 后凭据随临时文件清理（cleanup）
      - References 修正: 17 篇 §5.4 引用改为 git-credentials.ts 先例（:74-97）+ §5.4 凭证隔离原则（:307，凭证不进模型上下文/日志/审计事件），不引为 auth.json 文件权限依据（17 篇全文无 auth.json）
      - QA: happy——保存 token（指定 worker A）→ 仅 A 收到 → auth.json 写入 → serve 调模型成功；failure——未指定 → 全部在线 worker 收到；无 token 时降级失败态；command 一次性（心跳取出即清空）
      - Commit: `feat(worker): 模型凭据下发（含定向）与 auth.json 注入`

### Wave 4 - C6/C7/C8 前端与调度

- [x] 10. C6 前端模型管理页 + agent 页模型选择器（与 P0 原型 testid 全保留对齐；**支持选择已有模型 + 显示 provider + 首选 worker**）
      - References: `web/app/(main)/skills/page.tsx`（列表+操作+弹窗+isAdmin :1134 管理范式）、`web/app/(main)/agents/page.tsx:1052-1092`（模型选择器）、`:1565-1574`（available-models）、`:160-164`（**MODEL_NAMES 删除**）、`:78-81`（AvailableModel 类型提取为共享）、`web/e2e/reference/testids.ts`（新 testid 注册）、`docs/agent-platform/18-推进计划（分阶段实施）.md:111-164`（§3.1）、`web/src/components/layout/nav-dock.tsx`（NAV_ITEMS）、`web/src/components/layout/app-shell.tsx`（KEY_TO_PATH/PAGE_TITLE/CMDK_NAV_PATH）
      - Acceptance: 新增模型管理页（路由 + 导航 5 处：nav-dock NAV_ITEMS、app-shell KEY_TO_PATH/PAGE_TITLE/CMDK_NAV_PATH、cmdk-panel DEFAULT_CMDK_ITEMS；testid 与原型 models-manage 全量一致——grep diff 为空）；**agent 页模型选择器从目录拉取 enabled 模型 + 选项显示「provider / 模型名」格式（非仅名称）+ 保存时校验 defaultModelId 存在于目录（存量值不在目录 → 警告保留不阻断）**；**agent 页首选 worker 选择（agent.workerId 可空——C1 已建字段，选项来自 GET /workers 在线列表，说明"未选则自动调度"）**；provider/token 输入区（testid 与 agent-config 原型增强一致）；**删除 MODEL_NAMES 前置：先处理 :322/:796 两处引用（改为目录 name 查询逻辑）再删常量，避免编译失败**；AvailableModel 提取共享类型；新 testid 注册 testids.ts
      - QA: happy——模型管理页 CRUD 流 + agent 选择器显示 provider + 首选 worker + 保存带 token；failure——非 admin 隐藏管理操作（403 兜底）；选择不存在模型 → 校验拦截 + 存量兼容；首选 worker 离线 → 仍可保存（软绑定不阻断）
      - Commit: `feat(web): 模型管理页与 agent 模型/首选 worker/凭据配置`

- [x] 11. C7 分派/调度：模型解析优先级（Agent→模板→worker 默认→fallback）+ assignWorker 按模型可用过滤
      - References: `server/src/workers/workers.service.ts:279-303`（**assignWorker 实际位置**，现状仅版本+容量）、`server/src/chat/worker-dispatcher.ts:446-451`（toModelSelection）、`:910-925`（模型解析）、`docs/agent-platform/14-Agent配置与虚拟团队模型.md:158-161`（四模板默认模型）、`server/src/workers/workers.service.ts:28-32`（WorkerCapabilitiesShape）
      - Acceptance: **模型解析优先级实现**：Agent.defaultModelId（显式）→ **沿 baseAgentId 链向上取最近的非空 defaultModelId（模板默认；链可多层 clone of clone，取自 type=template 祖先或任意非空祖先，seed 已预置模板模型）** → **执行 worker 的 defaultModelId（兜底）** → **null（不指定，serve 默认）**；**解析结果为 null 时跳过模型过滤（回归现状行为——未配模型 agent 仍可调度到任意 worker）**；**assignWorker 增加可选 modelID 过滤**（候选 worker 须在 WorkerModelAvailability 含该模型且 enabled 或该 worker defaultModelId 匹配；模型为 null 时不过滤）；**availability 数据缺失降级策略写死：该 worker 从未上报（availability 无行）视为不受模型过滤约束（过渡期兼容），已上报但模型不符则排除**；worker-dispatcher 分派时按解析后模型过滤；**回归覆盖 assignWorker 全部 3 个调用点：worker-dispatcher.ts:396、:423、agents.service.ts:284（getAvailableModels 动态路径）**——改签名（加可选 modelID）后无参调用不受影响
      - QA: happy——agent 未配模型 → 用 worker 默认模型（单测覆盖优先级链 Agent→模板→worker→null）；failure——availability 缺失的旧 worker 不因过滤被全部排除；**agent 未配模型 + worker 无 defaultModelId → assignWorker 不过滤返回可用 worker（null 跳过过滤）**；无 worker 持该模型 → 明确错误
      - References 修正: toModelSelection **调用点 :451**（:446-451 块内 `toModelSelection(agent?.defaultModelId)`）、**定义 :911-925**；模板默认模型源自 seed 预置（14 篇 :158-161 仅"模型侧重"文字描述，无具体值，不能作为来源）
      - Commit: `feat(dispatch): 模型解析优先级 + 分派按模型过滤`

- [ ] 12. C8 worker 默认模型配置 + worker 详情页模型卡（显示 provider + 默认模型标识）
      - References: `server/src/workers/workers.service.ts`（Worker 更新逻辑）、`server/src/workers/workers.controller.ts:58-70`（列表/详情）、`web/app/(main)/workers/[id]/page.tsx`（详情页卡片 :394-481）、`web/app/(main)/workers/shared.tsx`（cardStyle/SectionHeader/SectionEmpty 复用）
      - Acceptance: PATCH /workers/:id 支持更新 defaultModelId（AdminGuard，校验存在于目录；**全新端点——workers.controller.ts 现无 PATCH，无路由冲突**）；**worker 详情页新增可用模型卡：数据源 capabilities.models（C2 已上报持久化，离线可查）主选 + 目录查询兜底，列表显示 provider + 模型名 + 默认模型标识（defaultModelId 高亮）**；**toWorkerView 需新增 defaultModelId 字段（现 :366-387 不含；可复用的是 capabilities 透传模式）**
      - References 修正: SectionEmpty 定义于 `workers/[id]/page.tsx:105` 本地（不在 shared.tsx；shared.tsx 仅 cardStyle/SectionHeader）；toWorkerView :366-387 需加 defaultModelId
      - QA: happy——设置 worker 默认模型 → 详情页高亮 + 分派未配模型 agent 用它；failure——defaultModelId 不在目录 → 校验拦截；详情页无 models 数据 → 空态
      - Commit: `feat(worker): worker 默认模型配置 + 详情页模型卡`

## Final verification wave

- [ ] F1. 计划符合度审计（oracle）：逐 todo 对照 Scope/IN-OUT 与用户决策（provider 显示、worker 默认模型兜底、软绑定、定向下发、模型解析优先级）
- [ ] F2. 代码质量评审（oracle）：AES-256-GCM 实现/auth.json 权限/白名单 DTO/异步化正确性/WorkerCommand 双端一致/模型解析优先级
- [ ] F3. 真实环境端到端 QA（ultrabrain agent 执行）：compose 13000/13001——注册 token（指定 worker）→ 下发 → 模型调用成功 + 原型/实现一致走查（testid diff 为空）+ provider 显示断言 + worker 详情模型卡/默认模型断言 + 未配模型 agent 用 worker 默认
- [ ] F4. 范围保真（oracle）：未做 OUT 项（不做模型推理/不硬绑 agent/不删 server 兜底/不改 serve/不动其余 16 原型页）

## Commit strategy

- 每个 todo 一个 commit（P0.1/P0.2/P0.3/C1/C2/C3/C4/C5a/C5/C6/C7/C8），遵循约定式提交
- 不涉及 Java，无需 googleJavaFormat
- 同一需求小改 → `git commit --amend`
- **推送策略（需确认）**：仓库实际归属 xishuhq（ketabot 账号名下无此仓库，历史已验证）；用户上轮明确「直接提交到 xishuhq/master」——本计划沿用此授权，执行前再向用户确认一次

## Success criteria

- 模型目录中心化：models 表持久化（seed 预置 8 模型防空目录），worker 上报真实模型合并入库，available-models 读目录（无在线 worker 也可查）
- 凭据闭环：保存 provider token（AES-256-GCM 加密，**可指定 worker**）→ 下发 → worker 写 auth.json（600 权限）→ opencode 实际调用成功
- **provider 显示**：agent 模型选择器 / worker 详情模型卡 / 模型管理页全部显示 provider + 模型名（非仅名称）
- **worker 默认模型兜底**：Agent 未配模型 → 用执行 worker 默认模型（模型解析优先级 Agent→模板→worker 默认→fallback 落地）
- **agent 首选 worker 软绑定**：可选配置，离线自动回退调度（不瘫痪）
- **worker 详情**：可用模型卡 + 默认模型标识（capabilities.models 主选）
- **agent 模型选择**：从目录拉取已有模型，支持选择，保存校验存在性（存量兼容警告）
- 调度增强：assignWorker 按模型可用过滤（availability 缺失降级，缺口⑤落地）
- 质量门：server jest 550+、worker jest 178+、e2e 全绿、原型 build/走查通过
- 安全：token AES-256-GCM 落库、fingerprint 脱敏、auth.json 600 权限、不进日志/响应
