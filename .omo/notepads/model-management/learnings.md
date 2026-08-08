# Learnings — model-management

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

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

- **models 字段结构决策**：`capabilities.models` 采用**对象数组** `Array<{providerID, modelID, name}>`（task 要求），非裸 id 字符串数组。理由：① 与 server DTO `WorkerModelInfoDto`（@ValidateNested + @Type）对齐——若 worker 发 string[] 而 DTO 声明对象结构，全局 ValidationPipe whitelist:true 下 ValidateNested 校验失败 → 400 拒绝注册；② C3 合并入库（upsert by providerID/modelID）与 C7 调度过滤直接消费字段，免二次拆解。
- **⚠️ 并行会话冲突处理**：仓库存在活跃并行任务（boulder `model-management-b9263bc4` 的 C3/C4 会话）曾把 worker 侧协议改为 `models?: string[]` + env `WORKER_DEFAULT_MODEL`，与 task 要求（对象数组 + `MODEL_DEFAULT_ID`）冲突，且造成 worker-protocol 与 server DTO 双端不一致。**决策：以 task 为准统一为对象数组 + `MODEL_DEFAULT_ID`**，恢复 worker-protocol.ts/index.ts/config.ts/contract.spec.ts/index.spec.ts 四处被并行覆盖的类型与 env 名。后续改动前先 `git diff` 核对并行会话是否已动同批文件。
- **异步化改造点清单**（worker/src/index.ts）：`buildCapabilities` → async（透传 models）；`buildRegisterOptions` → async（透传 models + defaultModelId）；`registerCurrent` → async（serve 就绪后 `await resolveModels(driver)`，结果传入 buildRegisterOptions）；启动链（:336-343）原本已 `await registerCurrent()` 无需改；`dispatchCommands`（:71-83）纯命令透传不涉注册组装，**无需改**——reload-config 链路经 restartCoordinator → reRegister → registerCurrent 自动刷新 models。
- **降级语义**：`resolveModels` 独立导出（可注入 mock listModels）：成功 → 对象数组（可为空 `[]`，表达"已探测无模型"）；失败 → undefined（不携带 models，不阻断注册）→ server 侧 C3 以"未上报"区分降级。成功空数组与失败缺省语义不同，测试覆盖两态。
- **defaultModelId 上报**：config.ts 新增 `MODEL_DEFAULT_ID` env（空串=未配置）→ WorkerConfig.defaultModelId → buildRegisterOptions 非空才携带 → registry-client body 透传 → server RegisterWorkerDto.defaultModelId（@IsOptional + @IsString）→ workers.service.register 落 `Worker.defaultModelId` 列（C1 已建，upsert create/update 均带）。
- **server 侧落库**：register 的 data 对象加 `defaultModelId: dto.defaultModelId ?? null`；capabilities 整块 Json 已含 models 透传（无需改落库逻辑）；toWorkerView 透传 capabilities 已含 models（C8 才加 defaultModelId 透出）。
- **验证**：worker build + jest 16 suites / 189 tests 全绿（基线 178 + 新增 11：index.spec 8 个 + contract.spec 3 个）；server build + jest 43 suites / 595 tests 全绿（基线 559 + worker-dto.spec 4 个 + 并行 C4 新增）。

## C5a: opencode auth.json 注入机制（2026-08-08，实测完成）

**结论（写死进 C5）**：
- **路径解析优先级**：`$XDG_DATA_HOME/opencode/auth.json` > `$HOME/.local/share/opencode/auth.json`（实验 3 两者同时设置时 XDG 胜出；strace 证实 serve 真实打开 `$XDG_DATA_HOME/opencode/auth.json`）
- **格式**：`{providerID: {type:'api', key}}`（本机 9 provider 全 type=api）
- **无 `--config` 支持**：`opencode serve --help` / `opencode --help` 均无 `--config` 参数；注入只能走 env（HOME 或 XDG_DATA_HOME）
- **主选方案**：worker 设置进程级 `XDG_DATA_HOME=<worker-data-dir>` + 写 `<dir>/opencode/auth.json`（600 权限）→ `spawnServe` env=`{...process.env}`（opencode-server.ts:282）自动继承 → 调 `restart()`（:201-206）生效。不改 spawnServe 签名、不动 cwd
- **加载实证**：auth.json 含 deepseek → `opencode models deepseek` 列出 4 模型；空 auth.json → `Provider not found`。auth.json 是 provider 可用性的唯一开关
- **降级**：无 auth.json → 0 credentials 静默降级，serve 正常启动（C5 失败态不会崩 worker）
- 证据：`.omo/evidence/c5a-auth-json.md`

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
