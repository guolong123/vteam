---
title: Agent 与模型管理测试用例
id: testcases-agents-models
order: 4
kind: 测试用例
description: Agent 配置与克隆、模型目录与凭据管理功能测试用例（正向+反向）
---

# Agent 与模型管理测试用例

## 1. 范围与依据

本模块覆盖「Agent 管理」（预置模板、克隆、完全自定义与五项配置）与「模型管理」（模型目录 CRUD、Provider 聚合、凭据加密存储与吊销）两部分的完整功能测试，用例编号前缀 `TC-AGT`（Agent）/ `TC-MDL`（模型），与 `00-总览与索引.md` §3 规范一致。

| 来源 | 文档 |
|------|------|
| 功能需求 | `04-功能需求-Agent与产出物.md`（FR-30~37/47/48） |
| 技术设计 | `14-Agent配置与虚拟团队模型.md`（§2 三种来源 / §3 五块配置 / §4 预置模板）、`16-内置Agent角色与提示词库.md`（角色与提示词库） |
| 页面设计 | `06-交互与页面设计.md`（§2.8 Agent 配置页、§2.13 模型目录管理页） |
| API 设计 | `09-API设计.md`（§3.7 Agents、模型章节；安全基线 `17-仓库权限与凭证机制.md` §3.4） |
| 实现代码 | `server/src/agents/`、`server/src/models/`、`server/src/common/credential-crypto.service.ts`、`server/prisma/schema.prisma` |

## 2. 测试环境

| 项 | 值 |
|----|----|
| API 入口 | http://192.168.10.78:13000/api/v1 |
| Web 入口 | http://192.168.10.78:13001 |
| 管理员 | `admin` / `admin123`（JWT Bearer）；seed 成员 `seed-member` / `Admin@123456` |
| 认证 | `POST /api/v1/auth/login` -H "Content-Type: application/json" -d '{"username":"admin","password":"admin123"}' → `{accessToken, refreshToken, user}`，后续请求带 `Authorization: Bearer <accessToken>` |
| Seed 数据 | 4 类模板 Agent（`a_product`/`a_architect`/`a_developer`/`a_tester`，type=template，含 defaultModelId）；模型目录 17 条（provider 前缀规范化）；内置工具 bash/read/edit/write/grep/glob |

> 以下用例默认前置「管理员已登录获取 accessToken」；`seed-member` 仅用于权限对照用例。实测用例均已在本环境执行验证，文中标注「已实测」的响应即为真实行为。

## 3. 实现与需求差异说明（以代码实现为准）

用例预期结果以下列实现事实为准，与需求文档不一致处显式标注：

| # | 差异/缺陷 | 需求依据 | 实现现状 |
|---|----------|---------|---------|
| D1 | **Agent 删除端点**：需求（14 篇 §9.1）称「本版无 Agent 删除端点」，实现提供 `DELETE /agents/:id` | 14 §9.1 | 实现：clone/custom 可删除（三表清理）；template 403 `PERMISSION_AGENT_READONLY`。**以实现为准** |
| D2 | **模板只读例外**：需求（14 §4.2）称模板 PATCH 一律 403；实现仅放行 `defaultModelId`/`ackMessage` 单字段更新（模型属部署环境适配） | 14 §4.2 | 实现：PATCH template 带 prompt/name 等 → 403；仅 defaultModelId/ackMessage → 200 |
| D3 | **type 过滤缺 clone**：需求（09 §3.7）`GET /agents?type=` 支持 template/clone/custom；实现 DTO 枚举仅 `['template','custom']` | 09 §3.7 | 实现：`GET /agents?type=clone` → 400；clone 类型 Agent 无法用 type 参数过滤 |
| D4 | **同名 Agent 不拦截**：Agent `name` 无唯一约束，重复同名创建返回 201（需求未明确唯一性，实现不校验） | FR-31/32 | 实现：同名可创建成功 |
| D5 | **工具 effect 枚举校验缺失**：需求（FR-48）effect 三态 allow/ask/deny；实现 `ToolEffectDto.effect` 仅 `@IsString()` 无 `@IsIn`，非法值（如 `maybe`）可入库 | FR-48 | 实现缺陷：`PATCH/POST` toolEffects 传入非法 effect 返回 200 且落库 |
| D6 | **删除被引用 Agent → 500**：`task_agents.agent`、`Agent.baseAgentId` 自引用均为 `onDelete: Restrict`，删除被任务引用或作为克隆源的 Agent 时 Prisma 外键约束异常，无业务层拦截 | 14 §9.1 | 实现：返回 500（非业务错误码），提示存在引用 |
| D7 | **available-models 不校验 Agent 存在**：`GET /agents/:id/available-models` 实现忽略 `:id` 参数（三路径：目录优先 → worker listModels → 静态 fallback），Agent 不存在也返回模型列表 | 09 §3.7 / FR-47 | 实现：任意 `:id`（含不存在）均返回 200 模型列表 |
| D8 | **凭据为 provider 粒度**：凭据按 providerID 存储（`model_credentials.provider_id` 逻辑关联，非 model 粒度），同 provider 下多个模型共享同一凭据 | 17 §3.4 | 实现：`POST /models/:id/credentials` body 缺省取 model.providerID，与 model 不一致 → 400 `MODEL_PROVIDER_MISMATCH` |

## 4. Agent 管理用例（TC-AGT）

### 4.1 正向用例

#### TC-AGT-001 查询 Agent 列表（含预置模板）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-001 |
| 用例名称 | 查询 Agent 列表，返回预置模板与分页结构 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；seed 预置 4 类模板 |
| 操作步骤 | 1. `GET /api/v1/agents?page=1&pageSize=100`（Bearer token） |
| 预期结果 | 1) 200，响应 `{items, total, page, pageSize}`；2) items 含 `a_product`/`a_architect`/`a_developer`/`a_tester`，type=template；3) 每项含 `name/role/prompt/baseAgentId/defaultModelId/permissionScope/skillIds/toolEffects` 等字段（已实测） |

#### TC-AGT-002 按 type 过滤模板列表

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-002 |
| 用例名称 | `GET /agents?type=template` 仅返回模板 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录；存在 template 与 custom Agent 各至少 1 个 |
| 操作步骤 | 1. `GET /api/v1/agents?type=template` |
| 预期结果 | 1) 200，`total=4`，items 全部 type=template；2) 不含 custom/clone 类型（已实测） |

#### TC-AGT-003 查询 Agent 详情（含完整关联）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-003 |
| 用例名称 | 查询单个 Agent 详情，含 skills/toolEffects 关联 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `GET /api/v1/agents/a_product` |
| 预期结果 | 1) 200；2) `type=template`、`baseAgentId=null`、`defaultModelId=opencode/ling-3.0-tiny-free`、`permissionScope={projects:"*",write:false,doclibOnly:true}`（已实测） |

#### TC-AGT-004 完全自定义创建 Agent（FR-32）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-004 |
| 用例名称 | `POST /agents` 从空白创建自定义 Agent（含全部配置项） |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；`defaultModelId` 取自 available-models 列表 |
| 操作步骤 | 1. `POST /api/v1/agents`，body：`{"name":"数据分析师","type":"custom","role":"analyst","prompt":"以数据分析师视角…","skillIds":[],"toolEffects":[{"toolAction":"read","effect":"allow"},{"toolAction":"bash","effect":"ask"}],"permissionScope":{"projects":["p_seed_1"],"write":false},"defaultModelId":"opencode-go/deepseek-v4-flash"}` |
| 预期结果 | 1) 201 + Agent 对象：`type=custom`、`baseAgentId=null`、`createdBy=当前用户id`、toolEffects 2 条、defaultModelId 原样保存；2) 页面侧「Agent 管理」列表出现该自定义 Agent（已实测） |

#### TC-AGT-005 克隆预置模板与自定义 Agent（FR-31）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-005 |
| 用例名称 | `POST /agents/:id/clone` 以模板/custom 为源克隆；name 缺省用「源名副本」 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；源模板 `a_product` 与 1 个 custom Agent（TC-AGT-004 数据）存在 |
| 操作步骤 | 1. `POST /api/v1/agents/a_product/clone`，body：`{"name":"项目产品经理"}`；2. `POST /api/v1/agents/<customId>/clone`，body `{}`；3. 分别 `GET /api/v1/agents/<新id>` 核对 |
| 预期结果 | 1) 201 + 克隆副本：`type=clone`、`baseAgentId=a_product`、`name=项目产品经理`、prompt/toolEffects/permissionScope/defaultModelId 与源一致；2) custom 源克隆成功，name 缺省时自动命名「源名副本」（如「数据分析师副本」）；3) `GET /agents/a_product` 源配置不变（深拷贝，已实测） |

#### TC-AGT-007 克隆副本修改不影响源（隔离验证）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-007 |
| 用例名称 | 修改克隆副本配置后源 Agent 不受影响 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | 存在克隆对：源 `A` 与副本 `B`（baseAgentId=A） |
| 操作步骤 | 1. `PATCH /api/v1/agents/B` body `{"prompt":"副本改过的提示词"}`；2. `GET /api/v1/agents/A` 与 `GET /api/v1/agents/B` 分别核对 |
| 预期结果 | 1) PATCH 200；2) 副本 B prompt 已更新、源 A prompt 保持原值，`baseAgentId` 仅作血缘追溯不联动（已实测） |

#### TC-AGT-008 更新克隆/自定义 Agent 配置（FR-33~36/47/48）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-008 |
| 用例名称 | `PATCH /agents/:id` 更新提示词/技能/工具/模型，配置即时生效于后续会话 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | 存在 clone/custom Agent |
| 操作步骤 | 1. `PATCH /api/v1/agents/:id` body `{"prompt":"新提示词","skillIds":["sk_1"],"toolEffects":[{"toolAction":"jenkins-*","effect":"ask"}],"defaultModelId":"opencode/deepseek-v4-flash-free"}`；2. `GET /agents/:id` 核对 |
| 预期结果 | 1) 200 + 更新后对象：prompt 更新、skillIds 重建为 `["sk_1"]`、toolEffects 重建为 1 条、defaultModelId 更新；2) 关联重建为「清空重建」语义（未显式传入的关联保持原值）；3) 页面配置面板五块实时刷新（已实测） |

#### TC-AGT-009 模板仅放行 defaultModelId 更新（例外，见 D2）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-009 |
| 用例名称 | `PATCH` 模板 Agent 仅更新 defaultModelId/ackMessage 放行 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录；模板 `a_product` 存在 |
| 操作步骤 | 1. `PATCH /api/v1/agents/a_product` body `{"defaultModelId":"opencode/ling-3.0-tiny-free"}` |
| 预期结果 | 1) 200 + 更新后对象（模板只读的部署环境适配例外，已实测） |

#### TC-AGT-010 删除自定义 Agent（含关联清理）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-010 |
| 用例名称 | `DELETE /agents/:id` 删除 custom Agent，清理 skills/toolEffects 关联 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | 存在未被克隆/未被任务引用的 custom Agent |
| 操作步骤 | 1. `DELETE /api/v1/agents/:id`；2. `GET /api/v1/agents/:id` 复核 |
| 预期结果 | 1) 200；2) 随后 GET 返回 404 `AGENT_NOT_FOUND`；3) agent_skills/agent_tool_effects 关联一并删除；4) 页面列表不再显示该 Agent（已实测） |

#### TC-AGT-011 available-models 三路径语义（FR-47）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-011 |
| 用例名称 | `GET /agents/:id/available-models` 目录优先 → worker 动态 → 静态降级 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；models 目录存在 enabled=true 模型（seed 17 条） |
| 操作步骤 | 1. `GET /api/v1/agents/a_product/available-models`（目录非空）；2.（受控环境）清空 enabled 模型且 worker 在线时重试；3.（受控环境）目录为空且无可用 worker 时重试 |
| 预期结果 | 1) 200 纯数组 `[{id:"opencode-go/deepseek-v4-flash",name:"DeepSeek V4 Flash"},…]`，id 为 `providerID/modelID` 格式，共 17 条（目录优先路径，已实测）；2) 目录为空且 worker 在线 → 200 纯数组，为 worker `GET /models` 实测模型（无 source 标记）；3) 均不可用 → 200 + `{models:[...], source:"fallback"}`（静态降级，显式标记）。⚠️ 当前 seed 目录非空走路径 1，后两条降级路径需受控环境验证 |

#### TC-AGT-013 项目成员查看与创建 Agent（[project] 权限）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-013 |
| 用例名称 | 项目成员（member）可查看、克隆与自定义 Agent |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | `seed-member` 登录；`GET /agents` 可见 |
| 操作步骤 | 1. `GET /api/v1/agents`（seed-member）；2. `POST /api/v1/agents` body `{"name":"成员Agent","type":"custom"}`（seed-member） |
| 预期结果 | 1) 200 列表可见（09 篇 §2.3：成员默认具备 Agent 查看/克隆/自定义）；2) 201 创建成功 |

### 4.2 反向用例

#### TC-AGT-014 未认证/无效 token 访问 Agent 端点

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-014 |
| 用例名称 | 无 token / 无效 token 访问 `GET /agents` 拒绝 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | 无 |
| 操作步骤 | 1. 不带 Authorization 调 `GET /api/v1/agents`；2. 带 `Authorization: Bearer invalid-token` 重试 |
| 预期结果 | 1) 401（未认证，全局 JwtAuthGuard）；2) 401（无效/过期 token 同样拒绝）（已实测 401） |

#### TC-AGT-015 type 过滤传非法枚举

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-015 |
| 用例名称 | `GET /agents?type=clone` 返回 400 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `GET /api/v1/agents?type=clone` |
| 预期结果 | 1) 400 `{"message":["type must be one of the following values: template, custom"]}`（D3 实现差异：枚举不含 clone，已实测） |

#### TC-AGT-016 查询不存在的 Agent 详情

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-016 |
| 用例名称 | `GET /agents/not_exist` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `GET /api/v1/agents/not_exist` |
| 预期结果 | 1) 404 `{"code":"AGENT_NOT_FOUND","message":"Agent not_exist 不存在"}`（已实测） |

#### TC-AGT-017 创建 Agent 名称为空

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-017 |
| 用例名称 | `POST /agents` name 为空/空白返回 400 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/agents` body `{"name":"","type":"custom"}` |
| 预期结果 | 1) 400（`@IsNotEmpty` 校验失败）；2) 不产生 Agent 数据（已实测 400） |

#### TC-AGT-018 创建 Agent 名称超长

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-018 |
| 用例名称 | `POST /agents` name 超 64 字符返回 400 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/agents` body `{"name":"<65个a>","type":"custom"}` |
| 预期结果 | 1) 400（`@MaxLength(64)` 校验失败）（已实测 400） |

#### TC-AGT-019 创建 Agent 传非法 type

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-019 |
| 用例名称 | `POST /agents` type=template 返回 400 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/agents` body `{"name":"x","type":"template"}` |
| 预期结果 | 1) 400（`@IsIn(['custom'])`，POST 仅支持 custom 创建；模板只能由平台预置）（已实测 400） |

#### TC-AGT-020 创建 Agent 传非法 defaultModelId 格式

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-020 |
| 用例名称 | `POST /agents` defaultModelId 非 provider/model 格式返回 400 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/agents` body `{"name":"t7","type":"custom","defaultModelId":"no-slash"}` |
| 预期结果 | 1) 400（正则 `^[a-z0-9-_.]+\/[a-z0-9-_.]+$` 校验失败）（已实测 400） |

#### TC-AGT-021 重复创建同名 Agent

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-021 |
| 用例名称 | 重复同名创建 Agent 不被拦截 |
| 用例类型 | 反向 |
| 优先级 | P2 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /agents` 创建 name=「测试重名」；2. 再次 `POST /agents` 同 name |
| 预期结果 | 1) 两次均 201 成功（D4：name 无唯一约束，实现不拦截重复同名，与需求未明确唯一性一致；如需唯一请在需求侧补约束） |

#### TC-AGT-022 工具 effect 传非法值

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-022 |
| 用例名称 | `POST/PATCH` toolEffects effect 传非三态值被接受（实现缺陷） |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/agents` body `{"name":"t22","type":"custom","toolEffects":[{"toolAction":"bash","effect":"maybe"}]}` |
| 预期结果 | 1) **201/200（缺陷，非预期 400）**：`ToolEffectDto.effect` 仅 `@IsString` 无枚举校验（D5），非法值 `maybe` 可落库。用例结论：应补 `@IsIn(['allow','ask','deny'])`，实现需修复，当前标记为待修复缺陷 |

#### TC-AGT-023 更新模板 Agent 被拒

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-023 |
| 用例名称 | `PATCH /agents/a_product` 修改 prompt 返回 403 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `PATCH /api/v1/agents/a_product` body `{"prompt":"新提示词"}` |
| 预期结果 | 1) 403 `{"code":"PERMISSION_AGENT_READONLY","message":"模板 Agent 只读，请先克隆副本再编辑"}`；2) 页面提示模板只读，改动需克隆（已实测 403） |

#### TC-AGT-024 更新不存在的 Agent

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-024 |
| 用例名称 | `PATCH /agents/not_exist` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `PATCH /api/v1/agents/not_exist` body `{"prompt":"x"}` |
| 预期结果 | 1) 404 `AGENT_NOT_FOUND` |

#### TC-AGT-025 删除模板 Agent 被拒

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-025 |
| 用例名称 | `DELETE /agents/a_product` 返回 403 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `DELETE /api/v1/agents/a_product` |
| 预期结果 | 1) 403 `PERMISSION_AGENT_READONLY`（模板常驻不可删）（已实测 403） |

#### TC-AGT-026 删除不存在的 Agent

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-026 |
| 用例名称 | `DELETE /agents/not_exist` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `DELETE /api/v1/agents/not_exist` |
| 预期结果 | 1) 404 `AGENT_NOT_FOUND`（已实测） |

#### TC-AGT-027 删除被克隆引用的 Agent

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-027 |
| 用例名称 | 删除作为克隆源（baseAgentId）的 Agent 返回 500 外键冲突 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | 存在 Agent A 及其克隆 B（B.baseAgentId=A） |
| 操作步骤 | 1. `DELETE /api/v1/agents/A`（B 未删除） |
| 预期结果 | 1) **500**（D6：`Agent.baseAgentId` 自引用 `onDelete: Restrict`，Prisma 外键约束异常，无业务拦截；已实测）；2) 建议：业务层应在删除前检测克隆链并给出明确提示 |

#### TC-AGT-028 删除被任务引用的 Agent

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-028 |
| 用例名称 | 删除已加入任务团队（task_agents）的 Agent 返回 500 外键冲突 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | 存在任务 T 且团队含自定义 Agent C（`task_agents` 有 C 记录） |
| 操作步骤 | 1. `DELETE /api/v1/agents/C` |
| 预期结果 | 1) **500**（D6：`task_agents.agent` 外键 `onDelete: Restrict`，删除被任务引用的 Agent 触发外键约束异常）；2) 建议：删除前校验任务引用并返回业务错误码（如 409），实现待补 |

#### TC-AGT-029 克隆不存在的源

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-029 |
| 用例名称 | `POST /agents/not_exist/clone` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/agents/not_exist/clone` body `{"name":"x"}` |
| 预期结果 | 1) 404 `AGENT_NOT_FOUND`（已实测） |

#### TC-AGT-030 克隆名称超长

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-030 |
| 用例名称 | `POST /agents/:id/clone` name 超 64 字符返回 400 |
| 用例类型 | 反向 |
| 优先级 | P2 |
| 前置条件 | 源 Agent 存在 |
| 操作步骤 | 1. `POST /api/v1/agents/a_product/clone` body `{"name":"<65个a>"}` |
| 预期结果 | 1) 400（`@MaxLength(64)`）（DTO 校验，参照 TC-AGT-018） |

#### TC-AGT-031 available-models 不校验 Agent 存在

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-AGT-031 |
| 用例名称 | 对不存在的 Agent id 调用 available-models 仍返回 200 |
| 用例类型 | 反向 |
| 优先级 | P2 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `GET /api/v1/agents/not_exist/available-models` |
| 预期结果 | 1) **200 + 模型列表（缺陷，非 404）**（D7：实现忽略 `:id` 参数，三路径查询与 Agent 无关）；建议：应先校验 Agent 存在 |

## 5. 模型管理用例（TC-MDL）

### 5.1 正向用例

#### TC-MDL-001 查询模型目录列表

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-001 |
| 用例名称 | `GET /models` 返回模型目录分页列表 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；seed 目录 17 条 |
| 操作步骤 | 1. `GET /api/v1/models?page=1&pageSize=100` |
| 预期结果 | 1) 200 `{items, total, page, pageSize}`；2) 每项含 `id/providerID/modelID/name/capabilities/enabled`；3) `id` 为 `md_<序号>`（已实测 total=17） |

#### TC-MDL-002 模型目录过滤与搜索

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-002 |
| 用例名称 | `GET /models` 按 enabled/providerID/modelID/name 过滤 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `GET /api/v1/models?enabled=true`；2. `GET /api/v1/models?providerID=opencode-go`；3. `GET /api/v1/models?name=deepseek` |
| 预期结果 | 1) 仅返回 enabled 模型；2) providerID 精确匹配（`opencode` 不误命中 `opencode-go`，实现已修）；3) name/modelID 模糊匹配（contains）；4) 页面模型列表随搜索实时过滤（已实测） |

#### TC-MDL-003 查询 Provider 聚合列表

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-003 |
| 用例名称 | `GET /models/providers` 返回 Provider 聚合（模型数+凭据状态） |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；至少 1 个 provider 已配置凭据 |
| 操作步骤 | 1. `GET /api/v1/models/providers` |
| 预期结果 | 1) 200 + 数组 `[{providerID, modelCount, configured, fingerprint, revokedAt}]`；2) `configured=true` 的 provider 返回脱敏 `fingerprint`（如 `sk-a****89xz`），未配置为 `fingerprint:null`；3) 绝不返回明文 token（已实测） |

#### TC-MDL-004 查询模型详情

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-004 |
| 用例名称 | `GET /models/:id` 返回模型详情 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `GET /api/v1/models/md_0000000001` |
| 预期结果 | 1) 200 + Model 对象（providerID=opencode-go、modelID=deepseek-v4-flash）（已实测） |

#### TC-MDL-005 创建模型目录条目（admin）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-005 |
| 用例名称 | `POST /models` 管理员创建目录条目 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；providerID/modelID 唯一 |
| 操作步骤 | 1. `POST /api/v1/models` body `{"providerID":"tc-pvd","modelID":"tc-model-001","name":"TC Test Model","enabled":true}`；2. 执行后清理：`DELETE /models/:id` |
| 预期结果 | 1) 201 + Model（id=`md_<序号>`，enabled 缺省 true）；2) 页面「模型管理」列表出现新条目（已实测） |

#### TC-MDL-006 更新模型目录条目/启停

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-006 |
| 用例名称 | `PATCH /models/:id` 编辑名称或启用/停用 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；目标模型存在 |
| 操作步骤 | 1. `PATCH /api/v1/models/:id` body `{"enabled":false,"name":"新名称"}`；2. `GET /models` 核对 |
| 预期结果 | 1) 200 + 更新后对象；2) `enabled=false` 后模型从 `available-models` 中消失（停用不出现在可选项）；3) 页面开关状态同步翻转 |

#### TC-MDL-007 删除模型目录条目

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-007 |
| 用例名称 | `DELETE /models/:id` 物理删除（先清 availability） |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | 存在未被引用的测试模型（providerID=tc-pvd） |
| 操作步骤 | 1. `DELETE /api/v1/models/:id`；2. `GET /models/:id` 复核 |
| 预期结果 | 1) 200；2) 随后 GET 404 `MODEL_NOT_FOUND`；3) `worker_model_availabilities` 中该模型关联一并清理（实现先 deleteMany availability 再删 model）（已实测） |

#### TC-MDL-008 设置模型凭据（脱敏存储）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-008 |
| 用例名称 | `POST /models/:id/credentials` 保存 provider token（AES-256-GCM 加密） |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；目标模型存在 |
| 操作步骤 | 1. `POST /api/v1/models/:id/credentials` body `{"token":"sk-tc-1234567890"}` |
| 预期结果 | 1) 201 + 脱敏视图 `{id, providerID, configured:true, fingerprint:"sk-t****7890", revokedAt:null}`；2) **响应不含 token 明文、不含 credentialRef**（已实测，grep 明文计数 0）；3) 页面凭据徽章变绿「已配置」 |

#### TC-MDL-009 重复设置凭据覆盖更新（幂等）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-009 |
| 用例名称 | 同 provider 重复 `POST /credentials` 覆盖更新指纹 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | 已配置凭据（TC-MDL-008 数据） |
| 操作步骤 | 1. `POST /api/v1/models/:id/credentials` body `{"token":"sk-tc-9999999999"}` |
| 预期结果 | 1) 200（upsert 覆盖更新，幂等无冲突）；2) `fingerprint` 变为 `sk-t****9999`，`revokedAt` 清空（已实测） |

#### TC-MDL-010 查询凭据状态（无明文）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-010 |
| 用例名称 | `GET /models/:id/credentials` 仅返回脱敏状态 |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；已配置凭据 |
| 操作步骤 | 1. `GET /api/v1/models/:id/credentials` |
| 预期结果 | 1) 200 `{configured:true, fingerprint:"sk-t****9999", revokedAt:null, createdAt}`；2) 响应不含明文 token/credentialRef（明文零接触）（已实测） |

#### TC-MDL-011 未配置凭据时查询状态

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-011 |
| 用例名称 | 未配置凭据的模型查询凭据状态返回 configured:false |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | 目标模型从未配置凭据 |
| 操作步骤 | 1. `GET /api/v1/models/md_0000000001/credentials`（该 provider 未配置时） |
| 预期结果 | 1) 200（非 404）`{id:"", providerID, configured:false, fingerprint:null, revokedAt:null, createdAt:null}`（已实测）；2) 页面凭据徽章灰「未配置」 |

#### TC-MDL-012 吊销模型凭据（软撤销）

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-012 |
| 用例名称 | `DELETE /models/:id/credentials` 吊销凭据（revokedAt 标记） |
| 用例类型 | 正向 |
| 优先级 | P0 |
| 前置条件 | 已配置凭据 |
| 操作步骤 | 1. `DELETE /api/v1/models/:id/credentials`；2. `GET /models/:id/credentials` 复核 |
| 预期结果 | 1) 200 + 视图 `configured:false`、`revokedAt` 已置位（软撤销保留审计轨迹）；2) 复核 configured:false、fingerprint 仍保留（已实测） |

#### TC-MDL-013 按 provider 吊销凭据

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-013 |
| 用例名称 | `DELETE /models/providers/:providerID/credentials` 按 provider 粒度吊销 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | 该 provider 已配置凭据（不依赖模型行存在） |
| 操作步骤 | 1. `DELETE /api/v1/models/providers/tc-pvd/credentials` |
| 预期结果 | 1) 200 + 脱敏视图（revokedAt 置位）；2) worker-only provider（目录无该 provider 模型）也能吊销（实现不依赖 model 行）（已实测） |

#### TC-MDL-014 凭据吊销后重新设置恢复

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-014 |
| 用例名称 | 吊销后再 `POST /credentials` 清除 revokedAt 恢复已配置 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | 凭据已吊销（TC-MDL-012/013 数据） |
| 操作步骤 | 1. `POST /api/v1/models/:id/credentials` body `{"token":"sk-tc-1234567890"}`；2. 查询状态 |
| 预期结果 | 1) 200 + `configured:true`、`revokedAt:null`（覆盖更新同时清除吊销标记）（已实测） |

#### TC-MDL-015 项目成员只读可见模型目录与凭据状态

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-015 |
| 用例名称 | member 可读模型目录/凭据状态，但不可写 |
| 用例类型 | 正向 |
| 优先级 | P1 |
| 前置条件 | `seed-member` 登录 |
| 操作步骤 | 1. `GET /api/v1/models`（seed-member）；2. `GET /api/v1/models/md_0000000001/credentials`（seed-member） |
| 预期结果 | 1) 200 目录可见；2) 200 凭据状态可见（GET 不挂 AdminGuard，成员只读）（已实测） |

### 5.2 反向用例

#### TC-MDL-016 未认证访问模型端点

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-016 |
| 用例名称 | 无 token 访问 `GET /models` 返回 401 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | 无 |
| 操作步骤 | 1. 不带 token 调 `GET /api/v1/models` |
| 预期结果 | 1) 401（全局 JwtAuthGuard） |

#### TC-MDL-017 查询不存在的模型

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-017 |
| 用例名称 | `GET /models/md_notexist` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `GET /api/v1/models/md_notexist` |
| 预期结果 | 1) 404 `{"code":"MODEL_NOT_FOUND","message":"模型 md_notexist 不存在"}`（已实测） |

#### TC-MDL-018 非法分页参数

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-018 |
| 用例名称 | `GET /models?pageSize=0` 返回 400 |
| 用例类型 | 反向 |
| 优先级 | P2 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `GET /api/v1/models?pageSize=0` |
| 预期结果 | 1) 400（DTO `@Min(1)` 校验；服务层 normalize 仅兜底缺省，非法显式值先被 DTO 拦截）（已实测 400） |

#### TC-MDL-019 重复创建模型条目

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-019 |
| 用例名称 | `POST /models` 撞 providerID+modelID 唯一键返回 409 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | seed 已存在 `opencode-go/deepseek-v4-flash` |
| 操作步骤 | 1. `POST /api/v1/models` body `{"providerID":"opencode-go","modelID":"deepseek-v4-flash","name":"dup"}` |
| 预期结果 | 1) 409 `{"code":"MODEL_EXISTS","message":"模型 opencode-go/deepseek-v4-flash 已存在"}`（已实测） |

#### TC-MDL-020 非法 providerID/modelID 格式

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-020 |
| 用例名称 | `POST /models` providerID 含大写/非法字符返回 400 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/models` body `{"providerID":"BadP","modelID":"m1","name":"M"}`；2. body `{"providerID":"","modelID":"m1","name":"M"}` |
| 预期结果 | 1) 400（slug 正则 `^[a-z0-9][a-z0-9-_.]*$` 校验失败）；2) 400（`@MinLength(1)`）（已实测 400） |

#### TC-MDL-021 创建模型必填字段缺失/超长

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-021 |
| 用例名称 | `POST /models` name 缺失或字段超长返回 400 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/models` body `{"providerID":"p","modelID":"m"}`（缺 name）；2. body `{"providerID":"p","modelID":"<129个a>","name":"M"}` |
| 预期结果 | 1) 400（name 必填）；2) 400（modelID `@MaxLength(128)`） |

#### TC-MDL-022 非管理员创建/删除模型

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-022 |
| 用例名称 | member 调 `POST/DELETE /models` 返回 403 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | `seed-member` 登录 |
| 操作步骤 | 1. `POST /api/v1/models`（seed-member）body `{"providerID":"p","modelID":"m","name":"M"}`；2. `DELETE /api/v1/models/md_0000000001`（seed-member） |
| 预期结果 | 1) 403（AdminGuard，写操作仅管理员）；2) 403（已实测 POST 403） |

#### TC-MDL-023 更新不存在的模型

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-023 |
| 用例名称 | `PATCH /models/not_exist` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `PATCH /api/v1/models/md_notexist` body `{"name":"x"}` |
| 预期结果 | 1) 404 `MODEL_NOT_FOUND` |

#### TC-MDL-024 更新模型撞唯一键冲突

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-024 |
| 用例名称 | `PATCH /models/:id` 改为已存在 providerID/modelID 返回 409 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | 存在两个不同模型 M1（opencode-go/deepseek-v4-flash）、M2 |
| 操作步骤 | 1. `PATCH /api/v1/models/M2` body `{"providerID":"opencode-go","modelID":"deepseek-v4-flash"}` |
| 预期结果 | 1) 409 `MODEL_EXISTS`（唯一冲突校验排除自身，撞他行即 409） |

#### TC-MDL-025 删除不存在的模型

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-025 |
| 用例名称 | `DELETE /models/md_notexist` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `DELETE /api/v1/models/md_notexist` |
| 预期结果 | 1) 404 `MODEL_NOT_FOUND` |

#### TC-MDL-026 设置凭据 token 格式非法

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-026 |
| 用例名称 | `POST /credentials` token 非 `sk-` 前缀或过短返回 400 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录；目标模型存在 |
| 操作步骤 | 1. `POST /api/v1/models/md_0000000001/credentials` body `{"token":"bad-token-no-prefix"}`；2. body `{"token":""}`；3. body `{"token":"   "}` |
| 预期结果 | 1) 400（正则 `^sk-[A-Za-z0-9_-]{8,}$` 校验失败）；2) 400（`@MinLength(1)` + 空白校验）；3) 400（`@Matches(/\S/)`）（已实测 1) 400） |

#### TC-MDL-027 设置凭据目标模型不存在

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-027 |
| 用例名称 | `POST /models/md_notexist/credentials` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | admin 已登录 |
| 操作步骤 | 1. `POST /api/v1/models/md_notexist/credentials` body `{"token":"sk-12345678"}` |
| 预期结果 | 1) 404 `MODEL_NOT_FOUND`（resolveProviderID 先查模型）（已实测） |

#### TC-MDL-028 设置凭据 providerID 不一致

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-028 |
| 用例名称 | `POST /credentials` body.providerID 与模型 providerID 不一致返回 400 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | 目标模型 md_0000000001（providerID=opencode-go） |
| 操作步骤 | 1. `POST /api/v1/models/md_0000000001/credentials` body `{"token":"sk-12345678","providerID":"zhipu"}` |
| 预期结果 | 1) 400 `{"code":"MODEL_PROVIDER_MISMATCH","message":"body.providerID=zhipu 与该模型 providerID=opencode-go 不一致…"}`（凭据按 provider 粒度存储，D8）（已实测） |

#### TC-MDL-029 非管理员设置/吊销凭据

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-029 |
| 用例名称 | member 调凭据写端点返回 403 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | `seed-member` 登录 |
| 操作步骤 | 1. `POST /api/v1/models/md_0000000001/credentials`（seed-member）body `{"token":"sk-12345678"}` |
| 预期结果 | 1) 403（AdminGuard） |

#### TC-MDL-030 吊销不存在的凭据

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-030 |
| 用例名称 | 未配置凭据时 `DELETE /models/:id/credentials` 返回 404 |
| 用例类型 | 反向 |
| 优先级 | P0 |
| 前置条件 | 目标模型 provider 从未配置凭据 |
| 操作步骤 | 1. `DELETE /api/v1/models/md_0000000001/credentials`（该 provider 无凭据时） |
| 预期结果 | 1) 404 `{"code":"MODEL_CREDENTIAL_NOT_FOUND","message":"模型 … 尚未配置凭据"}`（已实测） |

#### TC-MDL-031 按 provider 吊销不存在的凭据

| 字段 | 内容 |
|------|------|
| 用例编号 | TC-MDL-031 |
| 用例名称 | `DELETE /models/providers/:providerID/credentials` 无凭据返回 404 |
| 用例类型 | 反向 |
| 优先级 | P1 |
| 前置条件 | provider `tc-pvd-none` 未配置凭据 |
| 操作步骤 | 1. `DELETE /api/v1/models/providers/tc-pvd-none/credentials` |
| 预期结果 | 1) 404 `MODEL_CREDENTIAL_NOT_FOUND`（provider 粒度吊销同样校验存在性）（已实测） |

## 6. 执行注意与数据清理

- **勿删线上数据**：本模块用例创建的测试数据（自定义 Agent、测试模型、临时凭据）执行后须清理——删除自建 Agent（`DELETE /agents/:id`）、删除测试模型（`DELETE /models/:id`）并吊销其凭据（`DELETE /models/providers/:providerID/credentials`）。预置 4 类模板与 seed 模型目录不可删。
- **删除顺序约束（D6）**：删除 Agent 前须先删除其克隆链上的副本与被任务引用的记录，否则 500 外键冲突。
- **凭据安全**：`token` 明文只出现在请求体与加密存储；任何用例断言响应不含明文 token/credentialRef，仅允许脱敏 `fingerprint`。
- **凭据测试影响面**：`POST /models/:id/credentials` 保存成功会向 worker 触发凭据下发（失败不阻断保存，worker 注册回放兜底）；建议使用测试专用 provider（如 `tc-pvd`）以免影响既有 provider。
- **跨模块前置**：TC-AGT-028（删除被任务引用的 Agent）需先在 `docs/test-cases/02-项目与任务管理.md` 的任务用例中创建引用该 Agent 的任务。
- **实现缺陷跟踪**：D5（effect 枚举校验缺失）、D6（删除被引用 Agent 无业务拦截）、D7（available-models 不校验 Agent 存在）为已识别的实现缺陷，用例按当前行为断言并在结论中标注「待修复」。
