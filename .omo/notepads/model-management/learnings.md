# Learnings — model-management

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

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
