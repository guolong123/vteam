---
slug: custom-local-model
status: review-required
intent: clear
review_required: true
plan_path: .omo/plans/custom-local-model.md
plan_sha256: null
review_round_id: r1-20260821
pending-action: review .omo/plans/custom-local-model.md (momus + independent oracle)
review:
  momus:
    status: in_progress
    target: .omo/plans/custom-local-model.md
    round_id: r1-20260821
  independent:
    status: in_progress
    target: .omo/plans/custom-local-model.md
    round_id: r1-20260821
approach: 在 Model 表扩展 baseUrl/providerType 字段 + ModelCredential 支持无token本地模型（选 A 已确认） + Worker auth.json/配置注入兼容本地端点 + 前端模型管理新增本地模型表单 + 复用现有 Provider/目录流
decisions:
  - Q1= A（支持空 token 本地无鉴权，baseUrl 必填，空时不建 ModelCredential，worker 保证可用性） 
---

# Draft: custom-local-model

## Components (topology ledger)
| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| C1 | Prisma Model 扩展本地模型字段并迁移 | active | server/prisma/schema.prisma:481-495 server/prisma/migrations |
| C2 | 后端模型目录/凭据服务支持本地模型（无token、baseUrl校验、provider类型） | active | server/src/models/models.service.ts server/src/models/dto/* server/src/models/models.controller.ts |
| C3 | Worker 侧 opencode 集成支持本地 OpenAI 兼容端点（baseUrl注入 + 无鉴权） | active | worker/src/credentials/model-credential-injector.ts worker/src/driver/v1-driver.ts worker/src/index.ts |
| C4 | 前端模型管理页新增本地/自定义模型创建与编辑 | active | web/app/(main)/models/page.tsx web/app/(main)/models/providers-tab.tsx web/src/types/models.ts |
| C5 | Agent 模型选择与校验打通本地模型 | active | web/app/(main)/agents/page.tsx server/src/agents/* |
| C6 | 文档与种子数据收敛 | active | server/prisma/seed.ts docs/ |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| 本地模型协议 | 默认支持 OpenAI 兼容 HTTP 协议（baseUrl + 可选 apiKey），覆盖 Ollama/vLLM/LM Studio/本地网关 | 最通用，opencode 已内置 openai 兼容 provider；无需为每个运行时单独适配 | 否 - API 形状固定 |
| provider 粒度 | 本地模型作为独立 provider（如 ollama / vllm / local-custom），复用现有 providerID 概念；不新增全局 provider 注册表 | 最小侵入，复用 ModelCredential 按 provider 存储与下发通路 | 是 - 可后续增加 provider 元数据表 |
| 认证 | 本地模型允许 apiKey 为空（无鉴权场景），空 token 时不写入 ModelCredential 且不下发 auth.json，仅依赖 baseUrl 直连 | ollama 等本地部署常无鉴权，强制 token 会阻断本地使用 | 是 - 校验可放宽 |
| baseUrl 存储位置 | 新增到 Model 表（per-model），而非 ModelCredential | 不同模型可指向不同本地实例/端口；更细粒度且与 capabilities 模型 id 一致 | 否 - 需迁移 |
| 前端入口 | 在现有 /models 双 Tab 内新增第三 Tab 或在目录 Tab 增加“添加本地模型”按钮，而非新页面 | 用户需求“主入口只有一个模型管理”已统一到 /models，过渡成本最低 | 是 - 可抽独立页 |
| 健康检查 | 创建本地模型后后端仅做 URL 格式校验，不做实时连通性探测；探测由 worker listModels/执行时自然失败体现 | 避免创建时依赖本地服务在线；与现有云端模型一致（凭据正确性不在创建时验证） | 是 - 可后补探测端点 |

## Findings (cited - path:lines)
- 模型目录表：Model 仅有 providerID/modelID/name/capabilities/enabled，无 endpoint/baseUrl（server/prisma/schema.prisma:481-495）
- 凭据表：ModelCredential 按 providerID 唯一存储 credentialRef（AES-256-GCM）+ fingerprint，强依赖 token 存在（server/prisma/schema.prisma:512-528；server/src/models/models.service.ts:420-480）
- 目录 CRUD：CreateModelDto 校验 MODEL_SLUG_PATTERN，无 baseUrl；findAll 精确匹配 providerID（server/src/models/dto/create-model.dto.ts:21-66；server/src/models/models.service.ts:100-107）
- Provider 聚合：listProviders 合并 models groupBy + worker capabilities.models + ModelCredential 状态（server/src/models/models.service.ts:144-201）
- Worker 凭据注入：buildAuthJson/writeAuthJson 仅写 {providerID: {type:'api', key}} 到 $HOME/.local/share/opencode/auth.json（600） （worker/src/credentials/model-credential-injector.ts:42-70）
- Worker 模型发现：V1Driver.listModels 通过 /provider（有 key 或 opencode 免费）或回退 /api/model，status active 过滤（worker/src/driver/v1-driver.ts:375-427）
- opencode 启动：OpencodeServer spawn `opencode serve --pure --port --hostname`，健康检查 GET /（worker/src/runtime/opencode-server.ts:289-358）
- 前端模型管理：/models 双 Tab（catalog / providers），ProvidersTab ConfigureModal 仅输入 token（providers-tab.tsx:345-523），agents 页 model-select 来源为 available-models（catalog）（web/app/(main)/models/page.tsx, web/app/(main)/agents/page.tsx:1255-1284）
- Worker 注册：capabilities 含 models/baseUrl/mcpUrl/execPort/maxInstances，随 register/heartbeat 上报（worker/src/config.ts、server/src/workers/dto/register-worker.dto.ts）

## Decisions (with rationale)
| decision | rationale | alternatives rejected |
| --- | --- | --- |
| Model 扩展 `baseUrl?: string` + `providerType: string('cloud'\|'local'|'custom')` + 可选 `apiBase` | per-model baseUrl 支持多本地实例并存；providerType 区分校验与 UI 展示；最小迁移成本，复用现有 providerID | 另建 ModelEndpoint 独立表：重，且与现有 available-models（providerID/modelID）割裂 |
| ModelCredential 允许空或缺省（本地无鉴权 provider 不建行） | 保持现有加密/下发通路不变，仅跳过无 token 的本地 provider；已配置 token 的本地模型仍走加密下发 | 改凭据表增加 type 字段强绑定：迁移更大，查询需 join |
| Worker 侧：有 baseUrl 的本地 provider 写入 opencode config（opencode.json / env OPENAI_BASE_URL 风格）或拼入 auth.json 扩展字段；无 token 时写 `{type:'api', key:'dummy'}` 或跳过 key 校验但保证 /provider 仍上报 active | opencode 依赖 key 非空判断可用性；需保证本地模型在 listModels 可见 | 仅改 worker driver 伪造 hasKey：侵入小但需验证 opencode 是否接受 |
| 前端：目录 Tab 增加“添加自定义模型/本地模型”按钮，弹窗字段：providerID、modelID、name、baseUrl（本地必填，URL校验）、apiKey（可选）、enabled | 复用现有 CreateModelDto + 新增字段分支校验；管理门槛低 | 新增独立 /local-models 页面：与用户“单一入口”诉求冲突 |
| 校验：baseUrl 仅当 providerType=local/custom 时必填且必须 http(s) URL；cloud 类型 baseUrl 忽略 | 明确区分，避免云端模型误填 endpoint | 统一必填：云端模型无意义 |

## Scope IN
- Prisma schema 扩展 + migration（Model 新增 baseUrl/providerType/apiBase 等，兼容存量行默认 cloud）
- 后端 DTO/校验/服务/控制器更新（创建/编辑/查询返回 baseUrl，凭据可选化，listProviders 合并本地模型计数）
- Worker 侧凭据/配置注入更新（支持无 token + baseUrl 写入 opencode 配置并保证上报可用）
- 前端 /models 与 /agents 打通（新增本地模型表单、API 类型、凭据徽章对空 token 的展示）
- 种子数据与文档更新（示例本地模型 provider 如 ollama-local）
- 单元/集成测试与证据留痕

## Scope OUT (Must NOT have)
- 不新增独立的模型网关或代理层（不替本地大模型做负载均衡/路由）
- 不实现模型文件上传或本地大模型进程的生命周期管理（不拉起 ollama serve）
- 不重写 opencode serve 的模型发现协议（复用 /provider + /api/model）
- 不自动探测/健康检查本地 endpoint 连通性（创建时仅格式校验）
- 不改变现有云端模型的凭据加密/下发/吊销语义

## Open questions
| question | why it matters | answer / default |
| --- | --- | --- |
| 本地模型是否必须支持无 token（空鉴权）？ | 决定 ModelCredential 是否可缺省、Worker 是否需伪造 key | 已确认 A：支持空 token，baseUrl 必填，空时不建 ModelCredential |

## Approval gate
status: reviewed-approved
approach: 如上（Q1=A，已复审加固）
next-action: 执行 /start-work
approved_at: 2026-08-21
approved_answer: A
review_round: r1-20260821
review_result:
  momus: APPROVED_WITH_COMMENTS (已加固)
  independent_oracle: APPROVED_WITH_COMMENTS (已加固)
  applied_fixes:
    - 同 provider 多 model baseUrl 一致性校验 + 400 MODEL_BASEURL_CONFLICT（Todo3）
    - Worker 前置探测 opencode baseUrl 配置落点（Todo4 拆 4a/4b）并约定 providerID 前缀/或 model-metadata dispatch
    - 明确 Swagger 与 providerType/baseUrl 回显、审计日志保留

## Review receipts (r1-20260821)
### Momus (plan-critic) — APPROVED_WITH_COMMENTS
- 结构合规：Todos 列零且命名合规，Final 波 F1-F4 齐全，依赖矩阵闭环
- 发现：同 provider 多 baseUrl 冲突未约束、Worker 配置路径未经验证、DTO 跨字段校验需双重保障、Server→Worker baseUrl 同步通道未明示
- 已加固：Todo3 增加同 provider 冲突 400 与常量、Todo4 增加探测子步骤与一致性 warn、Todo3 增加 Swagger 与审计日志、明确无独立页面

### Independent Oracle (security/arch) — APPROVED_WITH_COMMENTS
- 架构：per-model baseUrl 选择正确（多实例并存），per-provider 存储才需网关；已补充同 provider 一致性约束避免 opencode 单 provider 单 baseUrl 覆盖
- 安全：baseUrl 仅 http(s) 校验足够（不做 fetch 的 SSRF 面小，且 worker 在受控网络）；token 可空分支已限定于 local/custom，cloud 仍强校验；600 权限保持
- 风险：opencode 配置落点不确定性已通过探测步骤对冲；listModels hasKey 分支需与 providerType 元数据同步（已增加 dispatch 元数据或前缀约定）
- 结论：无阻塞缺陷，加固后可执行

