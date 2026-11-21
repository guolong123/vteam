# 会话长期不活跃 → 下一次发起前主动压缩（终稿）

> 日期：2026-11-19　状态：**方案已定稿，待实施**
> 前序：37 篇 §9 R15（上下文膨胀）/ Q17（上下文压缩与裁剪）、05 篇 §3.4（token 压缩列为后续迭代）
> 证据分级沿用本仓库惯例：**✅ 实测** / **📄 契约** / **🔍 源码** / **⚠️ 未验证**
> `file:line` 为 2026-11-19 快照，**符号名才是耐久引用**。

---

## 0. 一句话

一条会话 **≥ N 天不活跃**（默认 3 天）**且**上下文**≥ 阈值**（默认 40k token）时，用户下一次发消息进来，
**先把引擎会话压缩掉，再投递这条消息**——让「用户回来的第一轮」直接跑在压缩后的上下文上，从而**降低这一轮的成本与延迟**。

### 0.1 已拍板的三项决策

| 决策 | 取值 | 说明 |
|---|---|---|
| 触发条件 | ① 不活跃 ≥ N 天（默认 **3**）**且** ② 上下文 ≥ 阈值（默认 **40k**），**且** ③ 会话干净 | 两者取「与」，避免小会话被无谓压缩 |
| 时序 | **压完再发** | 压缩完成才投递消息，**省的就是用户回来的这一轮** |
| 压缩对象 | **目标引擎会话本身**（`session.instanceRef`） | 与群聊无关；不按群做隔离 |

---

## 1. 为什么方案成立：三个关键机制已核实

### 1.1 `compact` 会唤醒会话 —— 所以必须「压完再发」

📄 `POST /api/session/{id}/compact`：
> "Durably admit a session compaction request. **Steers by default: it runs at the next step boundary** instead of waiting behind queued prompts."

压缩是**排进 inbox 并默认 steer**（会唤醒执行）。因此：

- ❌ 若把 `compact` 和 `sendMessage` 背靠背发出去（当前 `runExecution` 的做法，`exec-server.ts:2377-2411` 之后紧跟 prompt），
  会话被压缩唤醒后会**继续消化 inbox 里的下一条消息** ⇒ 消息**不会等**压缩 ⇒ 本轮仍跑旧上下文。
- ✅ 必须**串行**：`compact` → **等到压缩真正落完** → 才 `sendMessage`。

### 1.2 「落完」有确定信号，不用猜

候选判定（按可靠性排序）：

1. **`GET /api/session/{id}/context`** 的最新一条变成 `type:'compaction'` 且 `status:'completed'`（📄 契约："all messages after the last compaction"）；
2. `POST /api/experimental/session/{id}/wait`（"Wait for a session agent loop to become idle"，**204 No Content**）作为加速收尾，**不能单独用**——压缩与执行共用 loop，「idle」不区分是谁结束的；
3. 兜底超时（建议 `COMPACT_TIMEOUT_MS`，默认 120s）→ **放弃压缩、直接发消息**，绝不把用户卡死。

⚠️ 契约里 `session.compaction.*` 是 durable 事件、可作状态判定；但 worker 当前**丢弃**这些类型（`v2-event-map.ts:1218-1222`），
Phase 1 优先走 1+2，事件路作为 Phase 2 的优化。

### 1.3 轮次锁让「等待」安全：这段时间不会有并发消息插进来

- `SessionTurn.runningKey` 有唯一索引（`uk_session_turns_running`，`schema.prisma:481`），
  `claimNext()` 在**同一事务**里把轮次置 `running` 并写 `busyState='running'`（`session-turns.service.ts:107-157`）。
- 时序（`worker-dispatcher.ts:2754-2779`）：**消息先入队 → 再认领**。认领成功后本会话**独占**，其他消息只会留在 `pending`，等 drain。

⇒ **压缩窗口就在"已认领、未投递"之间**，天然互斥，**不需要额外的分布式锁**。
这是本方案能成立的关键前提，实施时必须保持「先 claim 再 compress 再 execute」的顺序。

---

## 2. 两个触发条件的判定口径

### 2.1 条件①：不活跃 ≥ N 天

```
idle = now - max(Session.lastActivityAt, 该会话最近 SessionTurn.endedAt)
```

- `lastActivityAt` 由 `persistSessionActivity` 双写（`worker-dispatcher.ts:5909-5924`），索引 `idx_sessions_status_last_activity` 现成；
- **不要用 `createdAt`**：一条会话可能很老但昨天刚用过。

### 2.2 条件②：上下文 ≥ 阈值

**这是本轮实测确认的部分**（此前我误判为"算不了"，已纠正）：

| 要素 | 来源 | 状态 |
|---|---|---|
| **分母**：模型窗口 | `GET /api/model` → `limit.context`（✅ 实测 2.0.28 返回 `{context, output, input?}`）；server 已存进 `Model.capabilities.limit.context`（`models.service.ts:1776-1793`） | ✅ |
| **分子**：当前上下文量 | 会话内 assistant 消息的 `tokens`，**只取「最后一次 compaction 之后」的消息** | ✅ 数据在，🔍 需新增驱动方法 |

**「分子」的两个硬约束（实施时务必遵守）：**

1. ❌ **绝不能把每步的 `tokens` 求和**：每步 input 已含此前全部上下文，求和会成倍高估（10 步 × 20k 报出 200k）。
2. ❌ **不能用 `Session.Info.tokens`**（`GET /api/session/{id}`）：那是会话**累计**（所有步之和），同样高估。

**推荐口径**：取最后一次 compaction 之后、**最后一条** assistant 消息的 `input + cache.read` ≈ 当前上下文大小；
若担心缓存语义差异，退回 `max(input, cache.read)` 或加安全系数。⚠️ `tokens.cache.read` 的确切语义需在联调时用一条真实会话核一次
（`TokenUsage.Info` 六字段见契约；`contract-baseline/README.md` 已登记 2.0.28 与 2.0.32 的口径差）。

### 2.3 条件③：会话干净

```
Session.busyState === 'idle'
  && 无 running 轮次（findRunningTurn === null，理应恒成立——我们刚认领到）
  && 无 pending receipt
  && 无 pending question（AgentQuestion.status='pending'）
```

### 2.4 判定必须使用的既有事实（避免误压）

- **模型换过 → 引擎会话已重建**（`session-lifecycle.service.ts:652-665` 清绑定、`resetSessionBindingsByMember` 删旧行建新行）：
  此时上下文本来就空，`上下文量` 自然小于阈值 ⇒ **条件② 自动挡掉**，无需特殊分支。
- **dsh 引擎**：无 compact 能力（`engine/dsh/runtime.ts:58-70` 能力位全 false；`dsh-driver.ts` 无 compact RPC）⇒ 能力位门控，**永不触发**。

---

## 3. 时序设计（压完再发）

```
用户发消息 → 落库 → SessionTurn.enqueue(pending) → claimNext() 成功（本会话独占）
        │
        ├─ server：isStale(session)?  ← 查 lastActivityAt + 上下文量（需读引擎，见 3.1 的结论）
        │     ├─ 否 → 照旧：POST /execute（无 compact 标志）
        │     └─ 是 → POST /execute { compact: { await: true } }
        │
        └─ worker.runExecution：
              ① 建/恢复引擎会话 + ensureModelFor
              ② compact(sid)  → 轮询 /context 直到 compaction completed（或 wait 加速）
              ③ sendMessage(sid, 用户消息)        ← 本轮跑在压缩后的上下文上
              ④ 正常事件流（task.completed / usage 落库）
```

### 3.1 为什么判定放在 worker，而不是 server 上 SQL 判

「上下文量」要读**引擎**（`/context` + 消息 tokens），server 拿不到。三个选项：

| 方案 | 评价 |
|---|---|
| A. server 先查库判条件①，命中才让 worker 判条件② | 省一次往返，但条件②本来就必须在 worker，**逻辑分裂两处** |
| **B（推荐）** | worker 在 `runExecution` 开头统一判定（条件①②③），命中才压。**判定与执行同处、只用一处真值** |

代价：每条消息多发一个"看看要不要压"的读操作（两次 GET，毫秒级）。若嫌重，可先用 server 侧 `lastActivityAt` 做**廉价预筛**：
把 `compactEligible: boolean`（仅条件①）随 `/execute` 下发，worker 只在 `true` 时才做条件②。

### 3.2 契约变更（最小面）

```ts
// ExecuteRequestPayload 新增
compactIfStale?: {
  minIdleMs?: number;        // 默认 3d
  minContextTokens?: number; // 默认 40_000
  awaitMs?: number;          // 默认 120_000：等压缩落完的上限，超时放弃
};
```

```ts
// OpenCodeDriver 新增（可选成员，dsh 不实现）
compactSession?(sessionID: string, delivery?: 'steer' | 'queue'): Promise<void>;
getContextInfo?(sessionID: string): Promise<{ tokens: number | null; lastCompactionAt: number | null; messageCount: number }>;
```

> 用可选成员而非强制实现，理由与既有 `ensureModel`/`ensureModelFor` 一致（`exec-server.ts:2382-2390`）：
> 避免 DshDriver 被迫写空壳。实现方：仅 `V2Driver`。

---

## 4. 数据模型

```prisma
model Session {
  // ...既有
  /// 最近一次成功压缩的时刻（只由 worker 回流置位，不是"决定要压"时）
  compactedAt   DateTime? @map("compacted_at")
  /// 最近一次压缩前/后的上下文 token 估算（观测用，不参与判定）
  compactTokenBefore Int? @map("compact_token_before")
  compactTokenAfter  Int? @map("compact_token_after")
}
```

- 一个迁移、三列，全部 nullable，**存量零回填**；
- **`compactedAt` 不重置空闲计时**：到期判定仍用 `lastActivityAt`/`endedAt`，否则压缩会污染业务活跃度并干扰判死 watchdog（`scanIdleSessions`）。
- **防重复压**：同一次静默期内只压一次 —— 条件 `compactedAt IS NULL OR compactedAt < 本次静默起点`。

---

## 5. 失败与边界

| 场景 | 行为 |
|---|---|
| `compact` 返回错误 / 409 | 记 warn，**照常投递消息**（fail-open，本方案绝不因压缩失败而阻塞用户） |
| 等待超时（`awaitMs`） | 放弃等待，**照常投递**；下一轮若仍满足条件可再试 |
| 上下文量为 0 / 读不到（新会话、模型换过重建、旧 worker） | 视为条件②不满足 → 不压 |
| dsh 引擎 / 旧 worker（无能力位） | 能力位 `compactSession` 缺省 false → 不压，行为与今天完全一致 |
| 压缩进行中用户又来一条 | 不可能同时进 `runExecution`：`runningKey` 唯一 + `claimNext` 事务（§1.3）。新消息留 `pending`，本轮结束 drain |
| worker 在压缩中途崩溃 | 轮次收口逻辑已有（`finish` 清 `runningKey`）；`compactedAt` 未写 ⇒ 下次重试 |

---

## 6. 成本账（必须写清，否则上线必被问）

设压缩前上下文 `C`、压缩后残余 `R`、稳态每轮 `≈ R`：

- 压一次的成本 ≈ 一次**全量输入** `C`（+ 一次总结输出）；
- 省下的是**本轮** `C - R` + 后续每轮 `C - R`；
- **盈亏平衡 ≈ 1 轮**：因为「压完再发」使**回来的这一轮本身就是省的**（这正是选这个时序的理由）。

| 场景 | C | R | 本轮净收益 | 判定 |
|---|---|---|---|---|
| 长会话、3 天后回来 | 150k | 25k | ≈ **省 125k input** | ✅ 明显划算 |
| 中等会话 | 40k | 10k | ≈ 省 30k input | ✅ 划算 |
| 短会话（< 阈值） | 8k | – | 不压 | ✅ 由条件②挡掉 |

⚠️ **仍需实测的两个数**：一次压缩的**真实耗时**（决定用户多等多久）与**真实残余比 R/C**（决定阈值定多少合适）。

---

## 7. 实施计划

| Phase | 内容 | 交付证据 |
|---|---|---|
| **P0 驱动能力（含实测）** | `V2Driver.compactSession` / `getContextInfo`；**实测**压缩耗时、R/C 残余比、`cache.read` 语义；补 driver conformance 用例 | spike 报告（真实 serve + 真实会话的三个数）+ 单测 |
| **P1 worker 编排** | `ExecuteRequestPayload.compactIfStale`；`runExecution` 内「判定 → compact → 等落完（context 轮询 + wait 加速 + 超时）→ sendMessage」；能力位 `compactSession` | exec-server 单测：命中/未命中/超时/失败 fail-open 四条路径 |
| **P2 server 接线** | `worker-dispatcher` 下发 `compactIfStale`（可选 `compactEligible` 预筛）；三列迁移；压缩完成回流置位 + 事件 | 端到端：造一条"C 大 + 3 天不动"的会话 → 发消息 → 断言先压缩后投递 |
| **P3 观测与调参** | 压缩前后 token、耗时进日志/`model_usages`；会话页显示「上下文约 x/y」 | 两周真实数据 → 定最终阈值 |

**P0 的实测方法**：`docs/agent-platform/opencode-v2-spike-results/` 的 mock-provider 落盘法，
可直接量出「压缩前后喂给模型的真实 input 差」——而这**正好就是成本收益的真值**，不用估。

---

## 8. 配置项

| Key | 默认 | 说明 |
|---|---|---|
| `SESSION_COMPACT_IDLE_DAYS` | `3` | 条件① 不活跃天数（`0` = 关闭整个特性） |
| `SESSION_COMPACT_MIN_CONTEXT_TOKENS` | `40000` | 条件② 上下文下限 |
| `SESSION_COMPACT_AWAIT_MS` | `120000` | 等压缩落完上限，超时放弃并照常投递 |
| `SESSION_COMPACT_TIMEOUT_MS` | `180000` | 压缩本身的超时预算 |

---

## 9. 遗留待验证（不影响开工）

1. ⚠️ `tokens.cache.read` 的确切语义（是否已计入 `input`）→ 决定分子口径要不要乘系数；
2. ⚠️ 压缩的实际耗时分布 → 决定 `AWAIT_MS` 默认值与前端提示文案；
3. ⚠️ 压缩后的真实残余比 `R/C` → 决定阈值是否要按窗口比例（而非绝对值）表达；
4. ⚠️ `GET /context` 在大会话上的响应体积/耗时（它返回完整消息体）→ 若过重，改用「消息列表只取尾部」的轻量估算。

---

## 附录 A：源码与契约证据

| 结论 | 出处 |
|---|---|
| `compact` durable 入队、默认 steer | `contract-baseline/openapi.json` · `/api/session/{sessionID}/compact` |
| `/context` = 最后一次压缩之后的消息 | 同上 · `/api/session/{sessionID}/context` |
| `/wait` = 等 loop 空闲，204 | 同上 · `/api/experimental/session/{sessionID}/wait` |
| `limit.context` 实测可得 | ✅ 本机 `opencode v2.0.28` 实测 `GET /api/model` → `limit:{context,output,input?}` |
| 模型窗口已归集进 server | `server/src/models/models.service.ts:1776-1793` |
| 轮次互斥（runningKey 唯一） | `schema.prisma:481`；`session-turns.service.ts:107-157` |
| 先入队再认领 | `worker-dispatcher.ts:2754-2779` |
| `/execute` 建模与对齐顺序 | `worker/src/exec/exec-server.ts:1275-1320, 2377-2411` |
| 驱动契约 | `worker/src/driver/opencode-driver.ts:397-471` |
| dsh 无压缩能力 | `worker/src/engine/dsh/runtime.ts:58-70`；`dsh-driver.ts` 无 compact |
| vteam 丢弃 compaction 事件 | `worker/src/driver/v2-event-map.ts:1218-1222` |
| 活动时间双写 | `worker-dispatcher.ts:5909-5924` |
| 改模型重建引擎会话 | `session-lifecycle.service.ts:652-665` |
| 能力位上报 | `server/src/workers/dto/register-worker.dto.ts:57-89` |
| 一成员一会话（`memberKey` 唯一） | `schema.prisma:432` |
| token 统计口径 | `worker-dispatcher.ts:174-233`（`parseUsageTokens`） |

## 附录 B：与前一版方案的差异

| 项 | 前一版 | 终稿 |
|---|---|---|
| 触发条件 | 只有"不活跃" | **不活跃 AND 上下文阈值**（避免压小会话） |
| 时序 | 曾担心"本轮省不了" | **压完再发**，本轮即省（坐实：`compact` 会唤醒，故必须串行） |
| 上下文量来源 | 曾判"算不了，只能用上一轮账单" | **可算**：分母 `limit.context`，分子取最后一条 assistant 的 `input+cache.read`（实测纠正） |
| 作用域 | 曾担心"跨群影响" | 就压**目标引擎会话**，与群聊无关；跨群影响仅为产品认知提示 |
| 群聊策略 | 群聊只提示、不压 | 取消该分支（按用户决定：谁收到消息就压谁的 session） |
