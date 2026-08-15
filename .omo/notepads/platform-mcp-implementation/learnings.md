# Learnings — platform-mcp-implementation

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---

## 2026-08-12 群聊「每人 3 条」修复 — 两端一致性（delta 侧 + 终态化侧）

- **根因**：t_0000000001 未为 4 个 agent 创建 private 频道（chat_channels 只有 task_group），群聊每人 3 条 = ACK + 流式 delta 处理过程回退落群聊 processing + task.completed 终态化把正文独白写进群聊。
- **新契约**：群聊回复只经 MCP group_post 工具直发。private 是 agent 内心独白（真实会话），群聊是汇总视图——处理过程/正文独白一律不落群聊。
- **改动 1（worker-dispatcher.ts handleTaskCompleted）**：`groupFallback = channel?.type === CHANNEL_TYPE.task_group`；groupFallback 时跳过正文落库（仅 completedSessions 标记 + emitFinal({messageId:''})），正常时照旧；`forwardToGroup` 转发块整体删除，只留 `void groupPost;`（方法定义可留作死代码，勿再调用）。
- **改动 3（worker-event.ingress.ts handleMessagePartDelta）**：`privateTarget` 反查后、`target = privateTarget ?? source` 前插入——`source.type === CHANNEL_TYPE.task_group && privateTarget === null` → `return true`（静默跳过，仅 debug 日志，不落库不广播）。私聊来源/有 private 频道行为不变。**两端必须同时改才彻底**：只改终态化侧（改动 1）而 delta 侧仍回退群聊，流式 processing 消息仍会出现在群聊。
- **测试同步陷阱**：改动后除 2004/2094/2204 外，还须排查 `forwardToGroup` 的 spy 断言（2247/2283 曾断言 fwd 调用 1 次）、groupFallback 场景的 create 断言（2314 曾断言 create 到群聊 1 次）、以及 1286「task_group 终态化」测试（曾断言 create + extractConclusionParts，现改为断言不 create + emitFinal）。grep `forwardToGroup|groupFallback` 与「终态化」是快速定位手段。
- **验证**：`npx tsc --noEmit` 0 错误；`npx jest --runInBand` 953 通过（基线 951 + 新增 2 个 ingress 测试：群聊无 private 跳过落库 / 群聊有 private 仍落 private）。

