# 证据：08 篇平台架构设计完成

日期：2026-08-06
目标文件：`docs/agent-platform/08-平台架构设计.md`（286 行，frontmatter title: 平台架构设计 / id: platform-architecture / order: 8 / kind: 技术设计）

## 交付内容

1. **技术栈选型**（§2）：NestJS 10（后端框架，对比 Express/Fastify）/ Next.js 15 App Router + React 19（05 篇已定）/ TanStack Query v5 + Zustand v5 / SSE 统一单向 / Prisma 5+（MySQL 8 + SQLite 双 provider）/ 内置账号 + JWT / pino / 本地文件系统 + 对象存储接口预留 / 本版内存队列 + QueuePort 抽象。
2. **控制面模块划分**（§3）：14 个 NestJS 模块；WorkersModule 四组件（Registry/Scheduler/LifecycleManager/HealthChecker）；opencode 集成仅经 WorkerClient/WorkerSseClient（07 篇 11.3 远程化），不直连。
3. **Worker 节点与 opencode 承载**（§4）：继承 07 篇 11.6 三层结构，本版 V1Runtime spawn 子进程。
4. **组件拓扑**（§5）：全链路 ASCII 图（前端 → 控制面 → Worker 池）+ 3 条数据流要点。
5. **数据模型**（§6）：21 张表划分（users→task_group_instances + audit_logs 预留）；双库兼容策略（字符串枚举 + Json 列）；一致性设计（状态机落库 + task_events、验收基线 accepted_flag、worker 事件幂等）。
6. **关键设计决策**（§7）：首期单机但走 HTTP/SSE 协议（07 篇 11.7）；统一 SSE + 事件 id 游标续拉；会话流链路 worker SSE→控制面落库→前端 SSE；状态机「服务层校验→落库→广播」三段式；首版不引入 Redis/BullMQ。
7. **本版 vs 下一版增强**（§8）：8 项能力预留表（通知/搜索/审计/对象存储/队列/WebSocket/会话恢复/Worker 分布）。
8. **风险与缓解**（§9）：5 项。

## 验证结果

| 检查 | 结果 |
|------|------|
| curl 注入命中 08 key（`"/docs/agent-platform/08-平台架构设计.md"`） | ✅ count=1 |
| md-docs build `--out-dir /tmp/site` 退出码 | ✅ 0 |
| 章节结构 `## N.` 数量 | ✅ 9 章连续 |
| 关键选型断言（NestJS/Next.js/TanStack Query/SSE/Prisma/MySQL/JWT） | ✅ 全命中 |
| 模块断言（WorkerRegistry/Scheduler/LifecycleManager/HealthChecker/OpenCodeDriver/V1Runtime/V2Runtime） | ✅ 全命中 |
| 数据表断言（task_events/artifact_versions/audit_logs） | ✅ 全命中 |
| 反断言（CREATE TABLE/INSERT INTO/SELECT */npm install/docker run） | ✅ 0（架构级无实现代码） |
| ASCII 拓扑图 | ✅ 47 行框图线 |
| 07 篇一致性（不推翻：控制面/数据面分离、不直连 opencode、Driver 抽象、每任务组一实例） | ✅ §1 继承表 + §3.3/§4 原样保留 |
| 仅创建 08 篇，未动 01-07 与原型 | ✅ |

## 一致性锚点（与 07 篇逐条对应）

- 07 篇 11.3 端点（instances/sessions/prompt/abort/models）→ §3.3 WorkerClient 调用表
- 07 篇 11.6 WorkerServer/TaskGroupRegistry/WorkerRuntime → §4 节点结构图
- 07 篇 11.7 单机形态（仍走 HTTP/SSE）→ §7.1 部署形态
- 07 篇 10.1 铁律（控制面永不直接起 opencode 进程）→ §3.3/§7.1
- 07 篇 9.1 v1 起步 v2 就绪 → §2.1 运行时行 + §4 V1Runtime/V2Runtime
