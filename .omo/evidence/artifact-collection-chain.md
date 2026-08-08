# 证据：09 篇 §5.4 产出物收集链路详设

任务：在 `docs/agent-platform/09-API设计.md` 补充「产出物收集链路」详设小节（§5.4，FR-38~41/43）。
背景：用户问「模型产出文档之后如何收集」，答案=事件驱动回流（Agent 产出 → worker SSE 事件 → 控制面 ArtifactsModule 校验归档）。

## 改动

- 文件：`docs/agent-platform/09-API设计.md`（唯一改动文件）
- 位置：§5.3 Worker 注册与心跳之后、§6 对外 API 与 Worker 控制协议的关系之前，新增 `### 5.4 产出物收集链路（FR-38~41/43）`
- 内容 8 块：
  1. 链路总览 Mermaid 时序图（AG → W → CTRL ArtifactsModule → DB → FE，alt 分流结论文本/文档文件）
  2. 结论文本直接归档（FR-40，text 在 task.completed payload，无需额外拉取）
  3. 文件拉取端点（FR-41，`GET /worker/:id/files/:path`，WorkerClient 调用，Worker 控制协议内 07 篇 11.3，不对前端暴露）
  4. 拉取失败重拉机制（pending artifact → 指数退避 3 次 2s/4s/8s → 标记失败不写 artifacts 表 → 会话恢复重拉）
  5. 大文件处理（默认 50MB 可配，超限仅记文件引用元数据 / 异步流式拉取，对接 05 篇 3.3 对象存储预留）
  6. 幂等（file part id / 内容 hash 去重，对齐 08 篇 §6.3 至少一次投递）
  7. 验收联动（artifact.submitted 广播；FR-04 验收后更新→任务退回进行中；409 ARTIFACT_ACCEPTED_IMMUTABLE 呼应 §3.6）
  8. 衔接既有 §3.6 尾注（事件驱动主路径）与 §4.3 事件消费表

## 验证

| 检查项 | 结果 |
|--------|------|
| 本地 grep「产出物收集链路」 | 1 ✅ |
| 本地 grep「文件拉取」 | 1 ✅ |
| 本地 grep「重拉」 | 4 ✅ |
| 本地 grep「大文件」 | 2 ✅ |
| 本地 grep「幂等」 | 11 ✅ |
| 本地 grep「GET /worker/:id/files/:path」 | 2 ✅ |
| 本地 grep「pending artifact」 | 2 ✅ |
| 本地 grep「ARTIFACT_ACCEPTED_IMMUTABLE」 | 2 ✅ |
| md-docs build --out-dir /tmp/site-artifact2 | exit=0 ✅ |
| curl 内容注入端点命中 `"/docs/agent-platform/09-API设计.md"` | ✅ |
| curl 注入端点含新小节文本（产出物收集链路/文件拉取端点/pending artifact） | ✅ |

## 约束遵守

- 只改 09 篇，未动 01-08 篇与 prototypes
- 未新增对外 API 端点（文件拉取为 worker 控制协议内，§6 边界保持）
- §5 详设编号延续：5.1 发消息+@触发 / 5.2 会话流查看 / 5.3 Worker 注册与心跳 / 5.4 产出物收集链路
