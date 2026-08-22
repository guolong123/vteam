# 待写实现说明：新增模型条目 UI（server: no change）

状态：**分析已收敛**，server side **零改动**；这是唯一定义的缺失物（前端『添加自定义模型』入口）。在改 `web/app/(main)/models/page.tsx` 前，把以下事实当契约确认对齐。改动目标=最小面、不进后台/数据模型；base=commit 1ad941d。

## 关键现状（server，已确认不变）
- **`CreateModel` 端点接受**未知 provider：POST/ PATCH `/api/v1/models`，body `{providerID, modelID, name}` + `enabled?`(可选)、`capabilities?`(可选)。未验证的 `(providerID, modelID)` 不会 force-enabled。→ 不需要新校验或数据表，只要前端提交表单即可；回退路径=现有 PATCH `/:id{...enabled:false}`（toggle unconfigured/待确认），与现有 `UpdateModel` contract 同构。**不在本 PR 改后端**。
- **凭据**仍走 provider 粒度 + C4(脱敏指纹/C3)，不随新条目一起建；token→worker 下发机制(auth.json / worker capability)全部保留,无改动。

## page.tsx 必写（最小面）
现有 CatalogTab `models` Tab(`card-shell`+card shell)+dialog，action 已在行内/列定义(Provider/modelID 展示、column action)。要补的只是：**每行『提供…』按钮+新模型弹窗 provider/methods 不变**。

### 关键细节（避免重造轮子，直接复用）
- `page.tsx`：catalog shell 组件 + column/row-action 已定义；复用现有样式/`slugPattern`;provider-edit hook(`/PATCH /:id{...providerID}`)——改动集中在 `edit-provider-id-from-page`。
- 提交=后端 POST contract(现有端点),无新增 API(只有路径存在)。API change = inline string,无需改 api client。
- 复用 provider methods：catalog list(`ModelsResponse`(provider/modelID)+已分页)—只读查询(目录里已有模型/Provider 聚合，非写操作)；配置凭据(`/models/:id/credentials` GET + `/api/v1/models/providers` GET)。

## 验证时注意（勿破坏既有列）
- **不要**改动 catalog「操作」区现有 provider/methods 暴露的 Provider 展示列(Provider、modelID、可用节点、凭据状态、启停)。新按钮是『添加模型』,**不影响既有可用性展示**(行内/表头可加,不进 Provider 聚合)。

## agent-default-modelId / worker-bootstrap（不在本 PR，仅确认上下文）
- `AGENT_DEFAULT_MODEL_ID` + seed-provider 模型 =『预置』『可用模型枚举』(agent config 创建=默认模型下拉),与新增条目入口是两件事;worker bootstrap『available-model-select』—不影响已建模型可用性。勿把 agent-default / worker-bootstrap『provider validation』并入本 PR(C3/ui 只涉及目录/Provider Tab)。
- provider→worker→serve auth / registry 注册(heartbeat/model availability)不动,纯后端契约+流程,无前端改动。**唯一缺口是 UI 创建入口**(plan『最小面=仅前端缺失创建入口』)。
