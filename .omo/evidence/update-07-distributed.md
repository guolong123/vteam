# 证据：07 篇新增第 11 章分布式 Worker 架构（2026-08-06）

## 变更范围
- 文件：`docs/agent-platform/07-opencode-v2-调研与架构决策.md`（288 → 409 行）
- 新增第 11 章「分布式 Worker 架构（控制面 / 数据面分离）」，11.1~11.7 共 7 节
- 冲突修正三处（仅加注，未删改原内容）：
  - 第 5 章 Worker 概念：改为"每个任务组在 Worker 节点内运行一个 opencode 实例（v2 演进为 Location 级），任务组隔离由 Worker 节点承载"，加注"完整形态见第 11 章分布式 Worker 架构"
  - 第 9 章 9.1/9.2：开头加"分布式语境修正"引用块（Driver → Worker 节点内 WorkerRuntime，控制面经 Worker HTTP 接口远程调用，接口定义不变即 11.3 HTTP 语义）
  - 第 10 章：章标题改"（单机形态）"并加总注；10.1~10.5 各小节标题加"（单机形态；分布式演进见第 11 章）"

## 第 11 章结构
- 11.1 总体形态：控制面/数据面分离 ASCII 架构图（Web UI 任务/群聊/产出物/Agent 配置 + Worker 注册表/调度器/生命周期管理 → 控制协议 → Worker 节点池）
- 11.2 Worker 注册协议：读配置 {serverUrl, workerId, 能力声明} → POST /api/workers/register → 心跳循环 → GET /api/workers 可见；worker 主动 outbound 连接
- 11.3 控制协议：服务端→worker 端点表（/instances、/sessions、/sessions/{sid}/prompt、/abort、DELETE /instances/{gid}、/models）+ worker→服务端 SSE 事件表（instance.created / session.updated / message.part.delta / agent.status / task.completed / worker.heartbeat）；= OpenCodeDriver 远程化
- 11.4 Worker 生命周期管理表：心跳检测/主动启停/自愈/任务亲和性/水平扩容
- 11.5 v2 迁移只动 Worker 侧：三层改动面表，控制面零改动
- 11.6 Worker 内部结构：WorkerServer / WorkerRuntime / TaskGroupRegistry 分层图
- 11.7 与既有决策呼应表（OpenCodeDriver/每任务组实例/skill-tool 流程/v2 同步）

## 验证
1. curl 注入端点命中：`"/docs/agent-platform/07-opencode-v2-调研与架构决策.md"` count=1
2. grep 断言（07 篇内）：控制面=20、数据面=4、注册=26、心跳=5、WorkerRuntime=6、任务下发=1、分布式=13、"11.5"=2 全 PASS
3. 章节结构：`## 11`（行 290）+ 11.1~11.7 全部存在
4. `npx md-docs build --out-dir /tmp/site-distributed` EXIT:0

## 约束满足
- 只改 07 篇；01-06 篇与原型未动
- 1-10 章原内容保留，仅 5/9/10 章做冲突修正加注
- 未引入未确认信息；frontmatter 未动；编号连续（第 11 章）
