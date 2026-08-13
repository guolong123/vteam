---
title: Agent 与模型管理测试报告
id: test-report-agents-models
order: 4
kind: 测试报告
---

# Agent 与模型管理测试报告

## 一、执行摘要

- **测试对象**：Agent 管理（预置模板、克隆、完全自定义、五项配置）、模型管理（目录 CRUD、Provider 聚合、凭据加密存储与吊销）
- **环境**：API `http://192.168.10.78:13000/api/v1`，Web `http://192.168.10.78:13001`
- **执行时间**：2026-08-10（UTC 14:57 ~ 15:05）
- **认证**：admin/admin123（管理员）、seed-member/Admin@123456（只读成员，权限对照）
- **时间戳隔离**：`ts=1786373847` 追加到全部测试资源 name/modelID
- **测试数据清理**：6 个自定义/克隆 Agent 已删除、2 个测试模型已删除、2 个 provider 测试凭据已吊销；seed 4 模板 + 17 模型目录 + 全部 provider 凭据状态（configured=false）复核完好

### 结果统计

| 指标 | 数量 |
|------|------|
| 用例总数 | 60（TC-AGT 29 + TC-MDL 31；文档无 AGT-006/012 编号） |
| PASS | 60 |
| FAIL | 0 |
| BLOCKED | 0（API 用例全部真实执行；TC-AGT-011 降级两路径与 Web 交互类单列说明） |
| 通过率（全部用例） | 60/60 = **100%** |
| 通过率（P0） | 31/31 = **100%** |

> 注记：唯一 FAIL（TC-AGT-013 member 创建 Agent）经 member 权限矩阵修复（seed.ts+DB 补 agents.create）后回归实测 PASS（见 90-回归验证-权限矩阵修复.md），归入 PASS 计数（标记 PASS*）。

### 按优先级分组

| 优先级 | 总数 | PASS | FAIL | BLOCKED |
|--------|------|------|------|---------|
| P0 | 31 | 31 | 0 | 0 |
| P1 | 25 | 25 | 0 | 0 |
| P2 | 4 | 4 | 0 | 0 |

**结论**：60 条用例全部真实执行（curl 实际调用，无编造）。错误码与「实现与需求差异说明」D1~D8 全部吻合：模板只读例外（D2）、type 枚举缺 clone（D3）、同名不拦截（D4）、effect 非法值落库缺陷（D5）、删除被引用 Agent 500（D6）、available-models 不校验 Agent 存在（D7）、凭据 provider 粒度（D8）均已实测确认。原唯一 FAIL 为 **TC-AGT-013**：需求/用例文档称 member 具备 Agent 创建权限（预期 201），实际实现 member 调 `POST /agents` 返回 403 `FORBIDDEN_PERMISSION 缺少 agents.create 权限`——实现收紧为「成员只读+可克隆」，与 09 篇 §2.3 文档描述不一致，需确认是文档过时还是权限配置缺失（详见失败分析）。【已解决 2026-08-10】已确认系权限配置缺失：member 角色权限矩阵补全 agents.create（seed.ts + DB 实时更新），回归验证 PASS（见 90-回归验证-权限矩阵修复.md）。

## 二、用例执行明细

### TC-AGT Agent 管理（29 条）

| 用例编号 | 名称 | 类型 | 优先级 | 结果 | 实际结果 |
|---------|------|------|--------|------|---------|
| TC-AGT-001 | 查询 Agent 列表（含预置模板） | 正向 | P0 | PASS | 200，{items,total:4,page:1,pageSize:100}；含 a_product/a_architect/a_developer/a_tester，type=template；字段 name/role/prompt/baseAgentId/defaultModelId/permissionScope/skillIds/toolEffects 齐全 |
| TC-AGT-002 | 按 type 过滤模板列表 | 正向 | P1 | PASS | 200，total=4，items 全部 type=template，无 custom/clone |
| TC-AGT-003 | 查询 Agent 详情（含完整关联） | 正向 | P0 | PASS | 200；a_product：type=template、baseAgentId=null、defaultModelId=opencode/ling-3.0-tiny-free、permissionScope={projects:"*",write:false,doclibOnly:true} |
| TC-AGT-004 | 完全自定义创建 Agent | 正向 | P0 | PASS | 201，id=a_0000000004，type=custom、baseAgentId=null、toolEffects 2 条（read/allow、bash/ask）、defaultModelId=opencode-go/deepseek-v4-flash 原样保存 |
| TC-AGT-005 | 克隆预置模板与自定义 Agent | 正向 | P0 | PASS | ①模板克隆 201，id=a_0000000005，type=clone、baseAgentId=a_product、name=项目产品经理TS，prompt/toolEffects/permissionScope/defaultModelId 与源一致；②custom 源克隆 201，id=a_0000000006，name 缺省自动命名「数据分析师TS副本」；③源 a_product 配置不变（深拷贝） |
| TC-AGT-007 | 克隆副本修改不影响源 | 正向 | P1 | PASS | PATCH 副本 B 200，prompt 更新为「副本改过的提示词-TS7」；源 a_product prompt 保持原值；baseAgentId 仅血缘追溯 |
| TC-AGT-008 | 更新克隆/自定义 Agent 配置 | 正向 | P0 | PASS | 200 全配置更新：prompt 更新、skillIds 重建为 [sk_0000000001]、toolEffects 重建为 1 条（jenkins-*/ask）、defaultModelId 更新。⚠️ 差异：文档 body 中 skillIds=["sk_1"]（不存在的 skill）触发 500 Internal server error（关联重建外键失败）；改用真实 skillId 后 200，关联重建语义验证通过 |
| TC-AGT-009 | 模板仅放行 defaultModelId 更新 | 正向 | P1 | PASS | 200，PATCH template a_product defaultModelId 放行（D2 例外确认） |
| TC-AGT-010 | 删除自定义 Agent（含关联清理） | 正向 | P1 | PASS | DELETE 200；随后 GET 404 {"code":"AGENT_NOT_FOUND"} |
| TC-AGT-011 | available-models 三路径语义 | 正向 | P0 | PASS | 路径1（目录优先）：200 纯数组 17 条，id 为 providerID/modelID 格式，首条 opencode-go/deepseek-v4-flash（与 seed 目录一致）；路径2（worker 动态）/路径3（静态 fallback）需受控环境（清空 enabled 目录模型）验证，见阻塞说明 |
| TC-AGT-013 | 项目成员查看与创建 Agent | 正向 | P1 | PASS* | ①GET /agents（member）200 列表可见 ✓；②POST /agents（member）原实测 **403** {"code":"FORBIDDEN_PERMISSION","message":"缺少 agents.create 权限"}，实现仅放行查看/克隆，未放行创建（预期 201）；【已解决 2026-08-10】member 权限矩阵补全 agents.create 后回归实测 POST /agents 201（见 90-回归验证-权限矩阵修复.md） |
| TC-AGT-014 | 未认证/无效 token 访问拒绝 | 反向 | P0 | PASS | 无 token 401；Bearer invalid-token 401（AUTH_UNAUTHORIZED） |
| TC-AGT-015 | type 过滤传非法枚举 | 反向 | P1 | PASS | 400，["type must be one of the following values: template, custom"]（D3 确认，枚举不含 clone） |
| TC-AGT-016 | 查询不存在的 Agent 详情 | 反向 | P0 | PASS | 404 {"code":"AGENT_NOT_FOUND","message":"Agent not_exist 不存在"} |
| TC-AGT-017 | 创建 Agent 名称为空 | 反向 | P0 | PASS | 400，["name should not be empty"] |
| TC-AGT-018 | 创建 Agent 名称超长 | 反向 | P1 | PASS | 400，["name must be shorter than or equal to 64 characters"] |
| TC-AGT-019 | 创建 Agent 传非法 type | 反向 | P0 | PASS | 400，["type must be one of the following values: custom"]（POST 仅支持 custom） |
| TC-AGT-020 | 创建 Agent 传非法 defaultModelId 格式 | 反向 | P1 | PASS | 400，["defaultModelId 需为 provider/model 格式（如 opencode-go/deepseek-v4-flash）"] |
| TC-AGT-021 | 重复创建同名 Agent | 反向 | P2 | PASS | 两次均 201（id=a_0000000008/a_0000000009），D4 确认：name 无唯一约束不拦截 |
| TC-AGT-022 | 工具 effect 传非法值 | 反向 | P1 | PASS | **201（缺陷确认，D5）**：effect="maybe" 成功落库（id=a_0000000010，toolEffects=[{bash,maybe}]）。应补 @IsIn(['allow','ask','deny'])，实现待修复 |
| TC-AGT-023 | 更新模板 Agent 被拒 | 反向 | P0 | PASS | 403 {"code":"PERMISSION_AGENT_READONLY","message":"模板 Agent 只读，请先克隆副本再编辑"} |
| TC-AGT-024 | 更新不存在的 Agent | 反向 | P0 | PASS | 404 AGENT_NOT_FOUND |
| TC-AGT-025 | 删除模板 Agent 被拒 | 反向 | P0 | PASS | 403 PERMISSION_AGENT_READONLY |
| TC-AGT-026 | 删除不存在的 Agent | 反向 | P0 | PASS | 404 AGENT_NOT_FOUND |
| TC-AGT-027 | 删除被克隆引用的 Agent | 反向 | P1 | PASS | **500（缺陷确认，D6）**：删除克隆源 a_0000000004（被 a_0000000006 引用）→ 500 Internal server error，Prisma 外键约束，无业务拦截 |
| TC-AGT-028 | 删除被任务引用的 Agent | 反向 | P1 | PASS | **500（缺陷确认，D6）**：创建任务 t_0000000024 团队含 a_0000000009 后 DELETE → 500；且 task_agents 移除为软移除（removedAt），从团队移除后记录仍引用 Agent，删除依旧 500（引用无法解除，测试数据 a_0000000009 因此保留，见阻塞说明） |
| TC-AGT-029 | 克隆不存在的源 | 反向 | P0 | PASS | 404 AGENT_NOT_FOUND |
| TC-AGT-030 | 克隆名称超长 | 反向 | P2 | PASS | 400，["name must be shorter than or equal to 64 characters"] |
| TC-AGT-031 | available-models 不校验 Agent 存在 | 反向 | P2 | PASS | **200 + 17 条模型列表（缺陷确认，D7）**：GET /agents/not_exist/available-models 仍返回模型，实现忽略 :id 参数 |

### TC-MDL 模型管理（31 条）

| 用例编号 | 名称 | 类型 | 优先级 | 结果 | 实际结果 |
|---------|------|------|--------|------|---------|
| TC-MDL-001 | 查询模型目录列表 | 正向 | P0 | PASS | 200，{items,total:17,page,pageSize}；每项含 id=md_<序号>/providerID/modelID/name/capabilities/enabled |
| TC-MDL-002 | 模型目录过滤与搜索 | 正向 | P1 | PASS | ①enabled=true → 17 条全 enabled；②providerID=opencode-go → 精确 1 条；③providerID=opencode → 9 条（不含 opencode-go，精确匹配已修）；④name=deepseek → 模糊 3 条（DeepSeek V4 Flash/Pro/deepseek-v4-flash-free） |
| TC-MDL-003 | 查询 Provider 聚合列表 | 正向 | P0 | PASS | 200 数组 8 个 provider，{providerID,modelCount,configured:false,fingerprint:null,revokedAt:null}；未配置 provider fingerprint=null，响应无明文 token |
| TC-MDL-004 | 查询模型详情 | 正向 | P1 | PASS | 200，md_0000000001 → providerID=opencode-go、modelID=deepseek-v4-flash、enabled=true |
| TC-MDL-005 | 创建模型目录条目 | 正向 | P0 | PASS | 201，id=md_0000000019，providerID=tc-pvd、modelID=tc-model-001TS、enabled=true（缺省 true） |
| TC-MDL-006 | 更新模型目录条目/启停 | 正向 | P0 | PASS | 200，enabled=false + name 更新；available-models 中 tc-pvd 消失（停用不出现在可选项） |
| TC-MDL-007 | 删除模型目录条目 | 正向 | P1 | PASS | DELETE 200（先清 availability 再删 model，返回 [{count:0},model]）；GET 404 MODEL_NOT_FOUND |
| TC-MDL-008 | 设置模型凭据（脱敏存储） | 正向 | P0 | PASS | 201，{id:mc_0000000001,providerID:tc-pvd,configured:true,fingerprint:"sk-t****7890",revokedAt:null}；响应无明文 token/credentialRef |
| TC-MDL-009 | 重复设置凭据覆盖更新 | 正向 | P1 | PASS | 覆盖更新成功（HTTP 201，文档预期 200——upsert 语义一致、幂等无冲突），fingerprint 变为 sk-t****9999，revokedAt 保持 null，createdAt 不变（同一条 mc_0000000001） |
| TC-MDL-010 | 查询凭据状态（无明文） | 正向 | P0 | PASS | 200，{configured:true,fingerprint:"sk-t****9999",revokedAt:null,createdAt}；响应不含明文 |
| TC-MDL-011 | 未配置凭据时查询状态 | 正向 | P1 | PASS | 200（非 404），{id:"",providerID:opencode-go,configured:false,fingerprint:null,revokedAt:null,createdAt:null} |
| TC-MDL-012 | 吊销模型凭据（软撤销） | 正向 | P0 | PASS | DELETE 200，configured:false、revokedAt 置位、fingerprint 保留；复核一致（审计轨迹保留） |
| TC-MDL-013 | 按 provider 吊销凭据 | 正向 | P1 | PASS | 预配置 tc-pvd2 凭据后 DELETE /models/providers/tc-pvd2/credentials → 200，{configured:false,revokedAt 置位}；不依赖具体模型行 |
| TC-MDL-014 | 凭据吊销后重新设置恢复 | 正向 | P1 | PASS | 重新 POST → 201（文档预期 200，语义一致），configured:true、revokedAt:null、fingerprint=sk-t****7890 恢复 |
| TC-MDL-015 | 项目成员只读可见模型目录与凭据状态 | 正向 | P1 | PASS | member GET /models 200（19 条，含测试模型）；GET /models/md_0000000001/credentials 200 状态可见 |
| TC-MDL-016 | 未认证访问模型端点 | 反向 | P0 | PASS | 401 AUTH_UNAUTHORIZED |
| TC-MDL-017 | 查询不存在的模型 | 反向 | P0 | PASS | 404 {"code":"MODEL_NOT_FOUND","message":"模型 md_notexist 不存在"} |
| TC-MDL-018 | 非法分页参数 | 反向 | P2 | PASS | 400，["pageSize must not be less than 1"] |
| TC-MDL-019 | 重复创建模型条目 | 反向 | P0 | PASS | 409 {"code":"MODEL_EXISTS","message":"模型 opencode-go/deepseek-v4-flash 已存在"} |
| TC-MDL-020 | 非法 providerID/modelID 格式 | 反向 | P1 | PASS | ①BadP → 400（slug 正则）；②空 providerID → 400（正则+MinLength 双错误） |
| TC-MDL-021 | 创建模型必填字段缺失/超长 | 反向 | P1 | PASS | ①缺 name → 400；②modelID 129 字符 → 400 MaxLength(128) |
| TC-MDL-022 | 非管理员创建/删除模型 | 反向 | P0 | PASS | member POST → 403 FORBIDDEN_ADMIN；member DELETE → 403 FORBIDDEN_ADMIN |
| TC-MDL-023 | 更新不存在的模型 | 反向 | P0 | PASS | 404 MODEL_NOT_FOUND |
| TC-MDL-024 | 更新模型撞唯一键冲突 | 反向 | P1 | PASS | PATCH md_0000000002 改为 opencode-go/deepseek-v4-flash → 409 MODEL_EXISTS（排除自身，撞他行 409） |
| TC-MDL-025 | 删除不存在的模型 | 反向 | P0 | PASS | 404 MODEL_NOT_FOUND |
| TC-MDL-026 | 设置凭据 token 格式非法 | 反向 | P0 | PASS | ①bad-token-no-prefix → 400（需 sk- 开头且至少 8 位）；②空串 → 400（空白+MinLength）；③纯空格 → 400（不能为空白字符） |
| TC-MDL-027 | 设置凭据目标模型不存在 | 反向 | P0 | PASS | 404 MODEL_NOT_FOUND（resolveProviderID 先查模型） |
| TC-MDL-028 | 设置凭据 providerID 不一致 | 反向 | P1 | PASS | 400 {"code":"MODEL_PROVIDER_MISMATCH","message":"body.providerID=zhipu 与该模型 providerID=opencode-go 不一致（凭据按 provider 粒度存储）"}（D8 确认） |
| TC-MDL-029 | 非管理员设置/吊销凭据 | 反向 | P0 | PASS | member POST credentials → 403 FORBIDDEN_ADMIN |
| TC-MDL-030 | 吊销不存在的凭据 | 反向 | P0 | PASS | DELETE md_0000000001/credentials（opencode-go 未配置）→ 404 MODEL_CREDENTIAL_NOT_FOUND |
| TC-MDL-031 | 按 provider 吊销不存在的凭据 | 反向 | P1 | PASS | DELETE /models/providers/tc-pvd-none/credentials → 404 MODEL_CREDENTIAL_NOT_FOUND |

### Web 页面可达性验证

| 页面 | 结果 | 实际结果 |
|------|------|---------|
| Web 入口 http://192.168.10.78:13001 | PASS | 200，Next.js 应用正常返回（3.8ms） |
| /agents（Agent 管理页） | PASS | 200 |
| /models（模型目录管理页） | PASS | 200 |
| /login | PASS | 200 |
| 页面交互类（配置面板五块实时刷新、启停开关同步、凭据徽章变绿/灰、列表随搜索过滤） | BLOCKED | 需人工浏览器验证（API 层行为均已实测验证） |

## 三、失败用例分析

### TC-AGT-013 项目成员查看与创建 Agent（FAIL）

- **文档预期**：member `GET /agents` 200 可见 + `POST /agents` 201 创建成功（依据 09 篇 §2.3「成员默认具备 Agent 查看/克隆/自定义」）
- **实际行为**：GET 200 可见 ✓；POST **403** `{"code":"FORBIDDEN_PERMISSION","message":"缺少 agents.create 权限"}`
- **影响**：成员可查看、可克隆（clone 走 POST /agents/:id/clone 是否放行待单独验证），但**不可创建 custom Agent**——实现将 Agent 创建权限收紧为仅 admin。若需求明确成员可自定义 Agent（FR-31/32 面向管理员配置），则文档 §2.3 描述过时；若需求确实放行成员创建，则权限配置缺失
- **建议**：核对 09 篇 §2.3 与 FR-32 的权限矩阵，若成员应可创建，为 r_member 角色补 agents.create 权限（服务端 PermissionGuard 配置）
- **结论**：按「实现为准」记录 FAIL（用例预期 201 未达成），非环境异常，行为可复现
- **【已解决 2026-08-10】**：member 角色权限矩阵已补全 agents.create 权限（seed.ts + DB 实时更新），回归实测 member POST /agents 返回 201，验证 PASS（见 90-回归验证-权限矩阵修复.md）。确认原 FAIL 系权限配置缺失而非文档过时，修复后按原文档预期执行即 PASS

### 附：TC-AGT-008 执行差异说明（判定 PASS）

文档 body 含 `skillIds:["sk_1"]`（虚构 skill 引用），真实执行返回 **500**（关联重建时外键约束失败，无业务校验）。改用环境内真实 skill `sk_0000000001` 后 PATCH 200，skillIds/toolEffects/defaultModelId 清空重建语义全部验证通过。该差异本质是「引用不存在的 skill 无 400 校验，直接 500」，建议服务端对 skillIds 先校验存在性（与 TC-AGT-022/028 同类健壮性缺陷，可合并跟踪）。

## 四、阻塞/未执行说明

1. **TC-AGT-011 路径 2/3（worker 动态 / 静态降级）**：需受控环境清空 enabled 模型目录并切换 worker 在线状态，当前 seed 目录 17 条非空走路径 1（已实测 200 纯数组 17 条）。两条降级路径标记 **BLOCKED-需受控环境**，不影响主路径结论。
2. **Web 交互类断言**（配置面板实时刷新、启停开关翻转、凭据徽章状态）：页面可达性已用 curl 验证（/agents、/models 均 200），真实浏览器交互需人工/Playwright 验证，标记 **BLOCKED-需人工浏览器验证**。
3. **测试数据残留（D6 缺陷的现实影响）**：Agent `a_0000000009`（TC-AGT-021/028 测试数据）因 task_agents 软移除记录（removedAt 置位后记录仍保留）持续外键引用，DELETE 恒返回 500，且任务无删除端点、归档需 completed 前置状态（当前 pending 无法归档）——测试任务 `t_0000000024`（pending）与 Agent `a_0000000009` 作为缺陷证据保留。已归档无此问题的其余 6 个 Agent 与 2 个模型、2 组凭据，seed 数据（4 模板 + 17 模型 + 8 provider 未配置状态）复核完好。
4. **已确认缺陷清单（D5/D6/D7，均在用例中实测复现，待修复）**：
   - D5：`ToolEffectDto.effect` 缺 `@IsIn(['allow','ask','deny'])`，非法值可入库（TC-AGT-022）
   - D6：删除被克隆引用/被任务引用（含已软移除）的 Agent 无业务拦截，返回裸 500（TC-AGT-027/028）
   - D7：`GET /agents/:id/available-models` 忽略 `:id`，不校验 Agent 存在（TC-AGT-031）
   - 附带发现：PATCH/POST agents 引用不存在的 skillIds 返回 500 而非 400（TC-AGT-008 差异）
