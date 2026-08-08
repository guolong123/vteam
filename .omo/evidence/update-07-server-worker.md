# 证据：07 篇统一为「服务端（控制面）+ worker（数据面）」立场

日期：2026-08-06
目标文件：`docs/agent-platform/07-opencode-v2-调研与架构决策.md`

## 改动摘要

1. **第 10 章整章重写**：标题「Worker 进程管理：v1 内嵌 vs 独立进程（单机形态）」→「Worker 节点内部运行时（V1Runtime / V2Runtime）」。删除全部「平台进程是父 / spawn opencode 子进程 / 平台按任务组 spawn」表述；改为 opencode 只承载于 worker 节点内部，服务端（控制面）永不直接起 opencode 进程，只通过 Worker HTTP 接口（11.3）下发指令。
2. **9.1/9.2 引用块强化**：明确 V1Driver/V2Driver 落地实现位于 worker 节点内部（11.6 WorkerRuntime），控制面远程调用，平台进程从不直接起 opencode 进程或直连 opencode。
3. **9.5 修正**：「平台为每个任务组启动独立 v1 server（进程）」→「每个任务组由 worker 节点承载一个 opencode 实例（v1 在节点内 spawn 子进程，见第 10 章）」+ 注完整形态见第 11 章。
4. **第 11 章衔接**：引言「前五章（5/9/10）描述单机形态落地」→「第 5/9/10 章分别从 Worker 概念、Driver 抽象、worker 节点内部运行时描述落地」；末段「单节点、进程内直连」→「单节点部署：控制面与 worker 同主机，但仍通过 11.3 HTTP/SSE 语义通信」；11.3「进程内调用」→「worker 节点内的函数调用」。
5. **技术事实保留**（主语改 worker 节点）：createOpencodeServer spawn 语义 + 源码证据（server.ts launch + OPENCODE_CONFIG_CONTENT）、v1 三种承载方式对比表、skill/tool 变更流程（写 SKILL.md → 重启该节点实例）、v2 Effect Scope + transform 热更新、v1/v2 运行单元对比表、10.5 结论四条。

## 验证结果

| 检查 | 结果 |
|------|------|
| curl 注入命中 07 key（`/docs/agent-platform/07-opencode-v2-调研与架构决策.md`）| ✅ count=1 |
| grep 正向：worker 节点 / 控制面 / V1Runtime / V2Runtime / Effect Scope | ✅ 34 / 31 / 6 / 6 / 9 |
| grep 反断言：平台为每个任务组启动、平台进程是父、平台 spawn、平台按任务组、服务端 spawn、平台进程（管理者）、平台进程可、平台自身进程、平台 = worker、平台是父 | ✅ 0 |
| 章节编号连续：`## 10. Worker 节点内部运行时` / `## 11. 分布式 Worker 架构` | ✅ |
| frontmatter 未动（title/id/order/kind/description） | ✅ |
| md-docs build `--out-dir /tmp/site` 退出码 | ✅ 0 |

## 反断言完整命令

```bash
grep -cE "平台为每个任务组启动|平台进程是父|平台 spawn|平台按任务组|服务端 spawn|平台进程（管理者）|平台进程可|平台自身进程|平台 = worker|平台是父" docs/agent-platform/07-opencode-v2-调研与架构决策.md
# → 0
```
