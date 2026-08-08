# Task 18 - RealtimeModule SSE 基座

## 目标
按 09 篇 §4 实现统一 SSE 事件基座：内部事件总线（EventEmitter）+ `GET /api/v1/events`（SSE，EventSource 可消费），事件格式 `{id, type, payload, timestamp}`，id 为主键游标，支持 `since` 断线续拉，心跳保活。

## 交付文件（server/src/realtime/）
| 文件 | 职责 |
|------|------|
| `realtime.service.ts` | 内部事件总线（EventEmitter）：`emit`/`broadcast`、递增 id 游标、`getEventsSince`、`subscribe` |
| `realtime.controller.ts` | `@Sse() GET /api/v1/events`：SSE 端点，支持 `since` 续拉 + 心跳保活 |
| `realtime.module.ts` | 装配 controller/service，**导出 RealtimeService** 供其他模块注入广播 |

## 事件格式（对齐 09 篇 §4.1）
```
event: <type>
id: <递增事件 id>        // 主键游标，断线续拉（EventSource lastEventId）
data: {"id":<事件 id>,"type":"<type>","payload":{...},"timestamp":"<ISO8601>"}
```

## 真实 SSE 帧验证（curl -N + 运行中服务）
```
event: task.status.changed
id: 1
data: {"id":1,"type":"task.status.changed","payload":{"taskId":"t_1","from":"pending","to":"running"},"timestamp":"2026-08-06T14:17:52.974Z"}

event: chat.message.new
id: 2
data: {"id":2,"type":"chat.message.new","payload":{"messageId":"m_1","channelId":"c_1","senderType":"user"},"timestamp":"2026-08-06T14:17:52.974Z"}
```

## SSE 端点握手（HTTP 头）
```
HTTP/1.1 200 OK
Content-Type: text/event-stream     ← EventSource 兼容
Connection: keep-alive
Transfer-Encoding: chunked
```
- 带 `?since=5` 参数同样返回 `200 + text/event-stream`，连接保持打开。

## since 断线续拉（id 为主键游标）
广播 4 条事件（id=1..4）。`?since=2` 仅返回 id>2 的遗漏事件：
```
event: c | id: 3 | payload: {"n":3}
event: d | id: 4 | payload: {"n":4}
```
`since` 大于最新 id 时返回空流（无遗漏补拉）；未传 `since` 返回全部存量（全新连接）。

## 单测（npm run test）
```
Test Suites: 5 passed, 5 total
Tests:       27 passed, 27 total
```
Realtime 相关：
- `realtime.service.spec.ts`：emit 返回完整事件帧、id 单调递增、broadcast 别名、subscribe 实时订阅、getEventsSince 续拉、getLatestId 游标同源
- `realtime.controller.spec.ts`：SSE 连接建立收到存量事件、实时广播被推送、since 续拉返回遗漏、无遗漏空流、未传 since 返回全部

## 路由注册
```
[Nest] RouterExplorer Mapped {/api/v1/events, GET} route
[Nest] RealtimeModule dependencies initialized
```

## 说明
- 本期仅基座，不产生具体业务事件（chat.message.new 等 Phase 2 由其他模块经 `RealtimeService.broadcast` 注入）。
- 未用 WebSocket（08 篇 §2.2 SSE 选型）；未修改 web/。
- 事件先落库后转发（08 篇 §7.3）为后续持久化职责；本基座采用内存环形缓冲（默认 1000 条）承载 since 续拉。