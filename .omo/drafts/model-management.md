# model-management - Work Plan Draft

> ulw-plan 草稿：模型管理与使用（原型先行 + 模型目录中心化 + 凭据管理下发）
> 状态：awaiting-approval（用户批准后新增"原型先行"范围变更，待重新确认）

## Intent

- **intent**: clear（目标明确：模型目录中心化 + 用户输入 provider token + 分派时下发对应 worker + **先做原型**）
- **review_required**: false（交付时询问是否要高精度评审）
- **test_strategy**: tests-after（用户确认）

## 用户决策（已确认 + 新增）

1. ✅ 存储形态：新增 `models` 表（持久化目录，跨 worker 一致、离线可查）
2. ✅ 目录作用域：统一目录 + worker 能力映射
3. ✅ 数据源/凭据：保存 agent 时获取 provider 列表 → 用户输入 token → 分派时下发对应 worker
4. ✅ 测试策略：tests-after
5. ✅ **新增（scope change）：先做原型计划，原型计划也写进模型管理计划**（2026-08-08 用户追加）

## 探索结论（事实源）

### 现状（模型）
- `Agent.defaultModelId`：自由字符串 `provider/model`（schema.prisma:285），无存在性校验
- available-models：实时 pull → 降级 STATIC_AVAILABLE_MODELS（agent.constants.ts:25-34）
- worker listModels 能力存在无调用方；capabilities.models 协议位预留未上报
- 前端 MODEL_NAMES 陈旧硬编码；四类模板 defaultModelId 全 null；无 Model 表/管理页
- docs 14 篇 §3.5 FR-47 + §:420 缺口⑤统一模型目录

### 凭据注入
- git-credentials.ts 先例（env 注入 + 临时文件 + 用完即删）
- opencode 三通道：auth.json / provider env / opencode.json provider 节
- worker 容器零凭据配置；spawnServe() env 注入点（opencode-server.ts:282-285）
- 下发通道：WorkerCommand 心跳下行命令（worker-protocol.ts:93-97）
- token 按 provider 全局；server 存储蓝本 = 17 篇 §3.1 credentials 表（AES-256-GCM，未落库）

### 原型体系（新探索）
- **17 个原型页面**：`docs/agent-platform/prototypes/<name>/index.tsx` + `_shared/` 三文件（styles.ts 102 行 token / components.tsx 8 组件 / nav.tsx 3 导航组件）
- **零配置注册**：md-docs CLI 自动扫描 `prototypes/<name>/index.tsx`（plugin.ts:74-100），URL `#/p/agent-platform/protos/<id>`；新页面建目录 + 写 index.tsx + 默认导出 PrototypeDef 即注册
- **原型先行、实现后置**（agent-platform-prd-prototypes.md:5,24）；验收 = `md-docs build` 退出码 0 + playwright 逐页无 console 错误 + data-testid 断言（:61-64,93-97）
- **前端与原型一致为最高约束**（18 篇 §3.1 :111-164）：token 逐字节 diff 为空、data-testid 全保留、四层验收（截图对比 + testid 断言 + Playwright 走查）；证据范式 phase2-prototype-parity.md + phase5-t10-final-check.md（17 页三维度终检）
- **现有模型相关原型**：agent-config 页 model-config/model-select/model-source-hint 区块（:487-570，mock 4 模型池）+ 四模板默认模型（:75-119）
- **缺口**：无"模型目录/凭据管理"独立原型页；agent-config 无 token 输入区

## Components ledger（topology lock，更新后 9 组件）

| id | 组件 | 一句话结果 | status |
|----|------|-----------|--------|
| P0 | 模型管理原型（先行）：models-manage 原型页 + agent-config 模型区增强 | 建 `prototypes/models-manage/index.tsx`（仿 skills-tools-manage）+ agent-config 补凭据区；md-docs 注册/走查/build 验收 | 决策完成（用户追加） |
| C1 | 模型目录数据层：Model 实体 + models 表 + 迁移 | id/providerID/modelID/name/能力标签/启用状态 + worker↔model 可用性映射 | 决策完成 |
| C2 | worker 模型上报：capabilities.models 注册/reRegister 上报 | serve 就绪后 await listModels 并入 buildCapabilities（异步化） | 探索完成 |
| C3 | server 模型目录服务：ModelsModule CRUD + 同步 + available-models 改读目录 | 仿 mcp-servers 骨架 + AdminGuard + 目录优先/pull 兜底 | 探索完成 |
| C4 | 模型凭据管理：ModelCredential 表 + token CRUD + 加密存储 | 仿 17 篇 credentials 表；保存 agent 时填 provider token | 探索完成 |
| C5 | 凭据下发：心跳下行命令携带 providerKeys → worker spawnServe env 注入 | 仿 git-credentials env 注入 + WorkerCommand 扩展 | 探索完成 |
| C6 | 前端模型管理页：列表+操作+弹窗（仿 skills）+ agent 页 token 输入 | 与原型 P0 对齐（18 篇 §3.1 testid 全保留） | 探索完成 |
| C7 | 分派/详情对齐：assignWorker 按模型可用过滤 + worker 详情页模型卡 | 调度按模型能力匹配（缺口⑤） | 探索完成 |

## Approval gate

- **status**: approved（用户确认整合方案）；Metis v2 复核 REPAIR 项已全部整合（R1-R3 P1 + R4-R8 P2 + R9-R14 引用修正）
- **approach**: 原型先行（P0）→ 模型目录中心化 + 凭据管理下发（含定向）+ worker 默认模型兜底 + agent 首选 worker 软绑定（C1-C8）
- **next**: 计划已写入 .omo/plans/model-management.md（12 实现 + F1-F4 验证波）——交付，等待用户选择执行方式或高精度评审
