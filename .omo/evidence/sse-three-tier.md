# 三级 SSE 链路补充证据（08/09 篇）

**任务**：将「三级 SSE 链路」明确补进 08/09 篇技术设计文档，回答"模型输出 SSE 和前端 SSE 是否同一个"——不同连接、协议同构、控制面做消费→落库→语义转换→转发。

## 改动清单

| 文件 | 位置 | 新增内容 |
|------|------|---------|
| `docs/agent-platform/08-平台架构设计.md` | §7.2 游标续拉后新增 `#### 7.2.1 三级 SSE 链路` | mermaid `flowchart TD` 四级节点图（① opencode 引擎事件流 → ② WorkerSseClient/worker→控制面 SSE → RealtimeModule 消费链 → ③ 控制面→前端 SSE）+ 4 条边界说明（①②③ 独立连接 / 帧格式同构 / 非透传 / 非另起一套） |
| `docs/agent-platform/09-API设计.md` | §4 开头、4.1 前新增 `### 三级 SSE 链路总览` | 三级关系文字说明 + 三级参数表（通道/协议/事件类型/消费动作）+ 边界句「前端 EventSource 只消费 ③ 业务事件，不直接连接 worker/opencode」，并明确本节定义的是第③级契约、② 消费表关联 §4.3 |

## 术语约定

- 引擎事件 = ② worker→控制面（内部协议，WorkerSseClient 订阅，07 篇 11.3）
- 业务事件 = ③ 控制面→前端（对外契约，前端 EventSource，09 篇 §4）
- RealtimeModule：消费 → 幂等落库 → 语义转换（引擎事件→业务事件）→ 按订阅者转发
- FR-18 内部过程不广播（思考/工具仅按需给 `sessions/:id/stream`）；FR-19 先落库后转发（断线游标补拉）

## 验证

1. `md-docs build`（workdir /data/git-project/aiagents）→ `EXIT=0`，构建完成 → `dist/`
2. grep 断言：
   - 08 篇含「三级 SSE 链路」「7.2.1」 ✅（L324）
   - 09 篇含「三级 SSE 链路总览」「第③级」 ✅（L216/L218）
3. curl/bundle 注入：`dist/assets/index-wQSPf5QT.js` 命中「三级 SSE 链路」(2) /「第③级」(1) /「三级 SSE 链路总览」(1) /「前端 EventSource 只消费 ③ 业务事件」(1) /「7.2.1」(3)
4. 未改动 01-07 篇、未改原型；未新增机制，仅把既有三级关系讲清

## 结论

PASS：两篇均已补齐三级 SSE 链路描述，08 篇含 mermaid 图与语义转换标注，09 篇以文字/表格呼应（未重复 mermaid），构建零错误。
