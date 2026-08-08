# 证据：07 篇追加第 10 章「Worker 进程管理：v1 内嵌 vs 独立进程」

日期：2026-08-06
交付：`docs/agent-platform/07-opencode-v2-调研与架构决策.md` 追加第 10 章（10.1~10.5），1-9 章未改动，其他文件未动。

## 背景

用户关键问题：「集成 SDK 后平台是不是就是 worker？能否重启自己？」本任务澄清该架构误区。

## 源码证据（/tmp/opencode-repo）

| 事实 | 源码位置 | 证据 |
|------|---------|------|
| `createOpencodeServer` spawn 独立子进程 | `packages/sdk/js/src/server.ts:22-100` | `launch("opencode", ["serve", "--hostname=...", "--port=..."], {env: {...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config)}})`；返回 `{url, close()}`，`close()` 调 `stop(proc)` |
| `createOpencode` 是 server+client 组合封装 | `packages/sdk/js/src/index.ts:8-24` | `createOpencodeServer()` + `createOpencodeClient({baseUrl})`，返回 `{client, server}`，本质仍是 spawn |
| `createOpencodeClient` 纯 HTTP 客户端 | `packages/sdk/js/src/client.ts:33` | 基于 fetch 的 `OpencodeClient`，需 baseUrl 连外部 server |
| v1 skill 启动时一次性发现，无 watch | `packages/opencode/src/skill/index.ts:173,259,273` | `discoverSkills` + `InstanceState.make("Skill.discovery")` 在 layer 构建时执行；`loadSkills` 启动即加载 |

## 验证结果

- curl `http://localhost:5177/@id/__x00__virtual:md-docs-content` | grep `opencode-v2-research` → 命中 1
- 本地 grep 断言 7/7：
  - createOpencodeServer=10、spawn=16、子进程=18、管理者=4、close()=10、Effect Scope=3、transform=11
- md-docs build 退出码 0（vite 构建完成 → dist）

## 章节要点

- 10.1 核心澄清：`createOpencodeServer` 本质是 spawn 独立 opencode 子进程（配置经 `OPENCODE_CONFIG_CONTENT` env 注入）；平台是父进程/管理者，不是 worker；"重启自己"= close() 杀子进程 + 重新 spawn，与平台自身进程解耦
- 10.2 v1 三方式对比表：createOpencodeServer（独立子进程，✅ 可重启）/ createOpencode（组合封装，本质仍 spawn；"进程内"是误读，v1 无 Scope 模型无法销毁重建）/ createOpencodeClient（纯 HTTP 客户端，外部管理）；结论：v1 推荐 createOpencodeServer
- 10.3 v1 skill/tool 变更流程：写文件 → close() → 重新 spawn → 启动时 discoverSkills 生效；代价仅限该任务组会话中断，隔离收益保留
- 10.4 v2 演进：Effect Scope 关闭即释放运行时；ctx.skill/tool/agent.transform 热更新无需重启；OpenCodeDriver 接口不变
- 10.5 结论：平台=worker 管理者；v1 用 spawn 实现可重启 worker；v2 用 Scope+transform 实现免重启热更新；生命周期管理收敛在 OpenCodeDriver 内
