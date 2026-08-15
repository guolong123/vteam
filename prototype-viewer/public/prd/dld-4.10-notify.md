<!-- 详细设计：在 hld-4.10 之上细化到数据库表结构与实现设计，可直接指导编码 -->

# 4.10 通知与 IM 集成 — 详细设计

## 1. 模块范围

本模块完成"人工在环"闭环的最后一公里：任务状态变更出站 Webhook（FR-1001）、企业微信机器人通知与审批待办卡片（FR-1002）、多 IM 渠道适配（FR-1003，预留）、IM 发起任务（FR-1004，M3）。实现上 NotificationRule 为声明式资源走通用表，投递记录走独立表 `notify_deliveries`；平台内部事件总线（内存 topic）统一事件源，出站安全（HMAC 签名 + SSRF 预检 + payload 截断）复用 4.8 urlguard。本文档给出 NotificationRule spec 结构、notify_deliveries 表 DDL、事件订阅分发、渠道适配器与模板引擎、投递重试的实现设计。需求基线 req-4.10（FR-1001~1004）。

## 2. 数据库结构设计

### 2.1 表清单

| 表名 | 用途 | 类型 |
|---|---|---|
| `resources(type='notification-rule')` | 通知规则（事件订阅 + 渠道 + 模板） | 通用资源表 |
| `notify_deliveries` | 投递记录（去重/重试/排障） | 独立表 |

### 2.2 表结构

**`resources.spec (type='notification-rule')`**：

```jsonc
{
  "events": ["task.succeeded","task.failed","task.waiting-approval"],
  "channels": [
    { "type": "webhook", "url": "https://ops.example.com/hooks/orchestra",
      "secretRef": "notify-webhook-secret",
      "retry": { "maxRetries": 5, "backoff": "exponential" } },
    { "type": "wecom", "robotId": "wecom-robot-ops", "secretRef": "wecom-robot-key" }
  ],
  "template": "notify-default",     // 模板名（命名空间级覆盖 > 平台默认）
  "enabled": true,
  "dedupeWindowSec": 60             // 事件聚合去抖窗口
}
// status: { "phase": "Active|Disabled", "lastDeliveryAt": "..." }
```

**`notify_deliveries`**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | uuid | PK | |
| rule_id | uuid | | 规则引用 |
| channel_type | text | not null | webhook/wecom/feishu/dingtalk |
| event_id | text | not null | 事件唯一 id（去重键） |
| task_ref | text | | 关联任务 |
| status | text | not null | ok/retrying/failed |
| attempts | int | not null default 0 | |
| next_retry_at | timestamptz | | |
| last_error | text | | |
| payload_hash | text | | HMAC 摘要（校验/对账） |
| created_at | timestamptz | not null default now() | |
| updated_at | timestamptz | not null default now() | |

索引：`(event_id, channel_type)` **唯一**（去重）；`(status, next_retry_at)`（重试扫描）；`(rule_id)`。

### 2.3 枚举/常量

```ts
// src/notify/events.ts
export const NOTIFY_EVENTS = ['task.succeeded','task.failed','task.waiting-approval',
  'approval.expired','task.paused','task.resumed','task.cancelled'] as const;
export const CHANNEL_TYPE = ['webhook','wecom','feishu','dingtalk'] as const;
export const DELIVERY_STATUS = ['ok','retrying','failed'] as const;
export const DELIVERY_DEFAULT_RETRY = { maxRetries: 5, backoff: 'exponential' } as const;
export const PAYLOAD_SUMMARY_TRUNCATE = 1024;    // 输出摘要 1KB 截断
export const DELIVERY_RETRY_INTERVAL_MS = 60_000; // 重试扫描周期
```

## 3. 实现设计

### 3.1 模块目录结构

| 文件 | 职责 |
|---|---|
| `src/notify/events.ts` | 事件类型定义、内存 topic 总线（publish/subscribe） |
| `src/notify/dispatcher.ts` | 规则匹配（events + enabled）→ 模板渲染 → 渠道分发 |
| `src/notify/template.ts` | 模板引擎（handlebars）：按事件类型渲染，变量注入 |
| `src/notify/webhook.ts` | 出站 Webhook：HMAC-SHA256 签名、HTTP 发送、重试退避 |
| `src/notify/wecom.ts` | 企业微信：群机器人卡片/文本发送、深链拼接 |
| `src/notify/adapters.ts` | 渠道适配器注册表（feishu/dingtalk 预留） |
| `src/notify/outbound.ts` | 出站安全：urlguard（复用 4.8）、payload 截断脱敏 |
| `src/trigger/im.ts` | IM 指令触发入口（M3，复用 Webhook 链路） |

### 3.2 核心类型与 Schema（zod）

```ts
// src/notify/events.ts
export interface NotifyEvent {
  id: string;                 // uuid，投递去重键
  type: NotifyEventType;
  traceId: string;            // 与 4.5 入站 Webhook 共享 traceId 语义
  taskRef?: string; ns: string;
  ts: string;
  payload: Record<string, unknown>;   // 仅摘要（1KB 截断），完整内容走 API 按权限拉取
}
export const bus = new EventEmitter();   // 内存 topic（M2 可换消息总线）
export function publish(e: NotifyEvent): void;
// src/notify/template.ts
export function render(templateName: string, data: RenderContext, ns: string): string;
  // 模板优先级：命名空间模板 > 平台默认；变量：taskName/node/approver/link/duration/cost
export interface RenderContext { event: NotifyEvent; links: { approvalDeepLink?: string }; }
```

### 3.3 事件类型与通知内容

| 事件 | 触发时机 | 模板变量（示例） | 通知形态 |
|---|---|---|---|
| `task.succeeded` | 成功终态 | 任务名/耗时/Token/成本 | 文本摘要 |
| `task.failed` | 失败终态 | 失败节点/错误分类/Trace 链接 | 文本摘要 |
| `task.waiting-approval` | 进入等待审批 | 产物名/流程版本/提交 Agent/检查点/TTL | **审批卡片**（深链） |
| `approval.expired` | 审批 TTL 到期 | 审批名/策略（fail/escalate/remind） | 提醒/升级通知 |
| `task.paused` / `resumed` / `cancelled` | 生命周期干预 | 任务名/操作者 | 状态摘要 |

**企业微信审批待办卡片 payload（FR-1002）**：

```jsonc
// POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<robotKey>
{
  "msgtype": "template_card",
  "template_card": {
    "card_type": "text_notice",
    "source": { "icon_url": "...", "desc": "Orchestra" },
    "main_title": { "title": "⏳ 待审批：需求文档评审" },
    "horizontal_content_list": [
      { "keyname": "流程", "value": "软件公司开发流程 v3" },
      { "keyname": "提交人", "value": "Agent 需求分析" },
      { "keyname": "检查点", "value": "review-gate（第 2 轮）" },
      { "keyname": "TTL", "value": "剩余 23 小时" }
    ],
    "card_action": { "type": 1, "url": "<consoleUrl>/#approval-detail/<approvalId>" }
  }
}
```

### 3.4 核心函数/服务

```ts
// src/notify/dispatcher.ts
export async function dispatchEvent(e: NotifyEvent): Promise<void>;
  // 1. 匹配所有 enabled 规则（events 包含 e.type）→ 2. render 模板
  // 3. 逐渠道适配器投递 → 4. 写 notify_deliveries
export async function retryScanner(): Promise<void>;     // 扫描 retrying 且到 next_retry_at 的投递
// src/notify/webhook.ts
export async function deliverWebhook(ch, payload, secret): Promise<void>;
  // HMAC-SHA256(body) → X-Orchestra-Signature；SSRF 预检；超时 10s
// src/notify/wecom.ts
export async function deliverWecom(robotId, payload): Promise<void>;
  // POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...（机器人 key 存 Secret）
// src/notify/adapters.ts
export const adapters: Record<ChannelType, ChannelAdapter>;
  // ChannelAdapter = { deliver(channel, payload): Promise<void> }；feishu/dingtalk 注册占位
// src/trigger/im.ts (M3)
export async function handleWecomCommand(msg): Promise<void>;
  // 解析指令 → RBAC 校验（task-initiator）→ 幂等键 wecom:${msgId} → createTask
```

### 3.5 关键流程实现

**事件 → 投递**：

```
4.5/4.6/4.9 状态变更 → publish(NotifyEvent)（内存 topic）
dispatcher 匹配 NotificationRule（events 包含 type && enabled）
  → 事件聚合去抖：同任务连续状态在 dedupeWindowSec 内收敛为最终态（防通知风暴）
  → render(template) → 按渠道分发
  → webhook：urlguard.assertSafeUrl → HMAC 签名 → POST → 写 notify_deliveries
  → wecom：拼卡片（标题/流程版本/提交 Agent/检查点/TTL/深链）→ 发送 → 写记录
投递失败 → attempts+1 → status=retrying, next_retry_at=now+退避
  → retryScanner 重投 → 耗尽 → status=failed + 告警（绝不静默丢弃）
```

**企业微信审批待办卡片（FR-1002）**：

```
事件 task.waiting-approval → render('approval-card')
  标题：⏳ 待审批：<产物名>
  正文：流程 <flow> v<version> / 提交 Agent / 检查点 <node>（第 N 轮）/ TTL 剩余
  深链：<consoleUrl>/#approval-detail/<approvalId>（consoleUrl 全局设置下发）
审批决策后 → 推送结果反馈（批准/驳回/打回摘要）→ 闭环
```

**IM 指令触发（M3，FR-1004）**：

```
企业微信回调（消息事件）→ handleWecomCommand
  → 指令解析（@机器人 发起需求分析 #issue-42）
  → RBAC：发起人需 task-initiator 角色（越权 → 明确错误 + 审计）
  → 幂等：buildIdempotencyKey({type:'im', eventId: msgId}) → createTask
  → input 参数化透传（issueNumber=42）
```

**投递重试调度**：

```
deliver 失败（网络/5xx/4xx 非 401）
  → attempts+1，写 notify_deliveries(status=retrying, next_retry_at)
  → 退避计算：fixed = base * attempts；exponential = min(base * 2^(attempts-1), 5min)
  → retryScanner（60s 周期）扫描到期的 retrying 行 → 重新投递
  → attempts > maxRetries → status=failed + alert（不静默丢弃）
去重：同一 (event_id, channel_type) 唯一约束，重复事件直接跳过（返回已投递状态）
```

**模板引擎多通道渲染（FR-1003）**：

```
render(templateName, ctx, ns) → 中间数据模型（语义化正文：title/subtitle/kvList/link）
  → wecomAdapter: 中间模型 → 企业微信 template_card
  → feishuAdapter（M2）: 中间模型 → 飞书卡片（消息卡片 JSON）
  → dingtalkAdapter（M2）: 中间模型 → 钉钉 markdown
  → 新增渠道仅注册适配器，事件源与模板逻辑零改动（NFR-08）
模板覆盖：命名空间模板（resources 同名 + annotations 标记）> 平台默认模板
```

**深链与全局设置**：

```
consoleUrl 存系统设置（settings 资源）；审批卡片深链 <consoleUrl>/#approval-detail/<id>
consoleUrl 变更：旧卡片链接经 302 重定向到首页兜底（前端路由兜底）
IM 指令触发（M3）：POST /api/v1/im-callbacks/wecom → handleWecomCommand
  → 解析指令（@机器人 发起需求分析 #issue-42）→ RBAC（task-initiator）→ 幂等 wecom:msgId → createTask
```

**事件源统一入口**：

```
4.5 任务状态变更（succeeded/failed/waiting-approval/paused/resumed/cancelled）
4.6 审批（approval.expired/approval.decided）
4.9 指标（token 速率，非通知事件）
→ 统一走 notify.publish(NotifyEvent)（内存 topic，M2 换消息总线）
→ 通知订阅与 4.5 入站 Webhook 触发共享 traceId 语义（入向/出向对称）
事件聚合去抖：同 task 连续状态在 dedupeWindowSec（默认 60s）内收敛为最终态，防通知风暴
```

### 3.6 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| 投递失败 | 重试退避（默认 5 次指数），耗尽告警，不静默丢弃 |
| 出站目标内网 | urlguard 预检拒绝 + 审计（SSRF，复用 4.8 规则） |
| 通知风暴 | 事件聚合去抖 + 渠道限速；旁路（失败不阻断任务执行） |
| payload 含凭据 | 只含摘要（1KB 截断），凭证明文绝不进 payload |
| 企业微信回调重复投递 | `wecom:msg-id` 幂等键去重（NFR-04） |
| 卡片深链失效 | consoleUrl 变更时旧链接 302 到首页兜底 |
| 模板缺失 | 回退平台默认模板，不抛错 |

### 3.7 测试要点

- 单元：HMAC 签名与校验往返；模板渲染变量注入与命名空间覆盖优先级；退避重试计算；payload 截断与脱敏。
- 集成：任务成功/失败收到带签名头且无凭证明文的 Webhook；等待审批时企业微信收待办卡片、点击直达审批详情并可决策、决策后收反馈；投递失败重试耗尽告警不丢失；新增飞书渠道仅注册适配器（事件源与模板零改动）；重复 IM 指令只创建一个任务且越权指令被拒。
