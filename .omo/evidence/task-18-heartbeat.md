# Task 18 - SSE 心跳保活验证

## 目标
心跳周期发送 SSE 事件保活（对齐 09 篇 §4.4：`events` 端点返回 `retry` 字段 / 保活帧，防止代理与中间件超时断连）。

## 实现
`realtime.controller.ts` 中 `HEARTBEAT_INTERVAL_MS = 15000`：SSE 连接建立后，`RealtimeController.events()` 的 Observable 内 `setInterval` 周期向订阅者推送 `heartbeat` 事件；连接断开（`unsubscribe`）时 `clearInterval` 释放计时器，避免句柄泄漏（单测全部通过且 jest 干净退出验证）。

## 真实连接验证（curl -N 等待 ~16s，运行中服务）
无业务事件时，连接保持打开，约 15s 后收到保活帧：
```
event: heartbeat
id: 1
data: {"id":null,"type":"heartbeat","payload":null,"timestamp":"2026-08-06T14:18:18.118Z"}
```

## 保活语义
- **Connection: keep-alive** + 周期 `heartbeat` 事件维持长连接，防止 Nginx/网关空闲超时掐断。
- 心跳帧为独立事件名 `heartbeat`，不占用业务事件 id 游标（`data.id` 为 null），不影响 `since` 续拉语义。
- 前端 EventSource 收到任意 data 帧即保活，重连后按 `lastEventId`/`since` 续拉（09 篇 §4.4）。

## 单测佐证
`realtime.controller.spec.ts` 中所有 SSE 订阅测试在断开时均触发 Observable teardown（`clearInterval`），`npm run test` 无 open-handle 告警并干净退出：
```
Test Suites: 5 passed, 5 total
Tests:       27 passed, 27 total
Time:        3.724 s
```