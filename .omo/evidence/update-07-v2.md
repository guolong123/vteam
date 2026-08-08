# Task 07: opencode v2 调研与架构决策（2026-08-06）

## 交付
- `docs/agent-platform/07-opencode-v2-调研与架构决策.md`
- frontmatter: title=opencode v2 调研与架构决策 / id=opencode-v2-research / order=7 / kind=技术调研 / description
- 8 个章节：决策 / v2 定位与动机 / v2 核心变更（表格）/ v2 API 与 v1 差异 / 平台基于 v2 的架构落地 / v2 生态可用性（2026-08 实测）/ 定期同步策略 / 风险与缓解

## 调研事实落点
- v2 beta 定位 "will become OpenCode 2.0"，3 个有意破坏变更（插件 API/server API/TUI 配置）
- 热重载动机（Dax）: "redesigned it for hotreloading" / "The v2 goal is granular reconfiguration"
- 嵌入 SDK: "In-process is only transport"，同一 HttpApi 契约
- Location: "A caller cannot swap context for an existing Session by passing a new path"
- durable session: "Durable admission precedes execution"
- 依赖方向 Schema→Core/Protocol→Server→Client，import-boundary 测试强制
- 生态实测: cli@beta=0.0.0-beta-202608060524（每日）/ sdk-next 未发布 / sdk v1=1.18.14
- 已移除端点: instructions/entries、/api/experimental/migration/v1

## 验证（curl + grep）
curl http://localhost:5177/@id/__x00__virtual:md-docs-content | grep -o '07-opencode-v2[^"]*'
=> 07-opencode-v2-调研与架构决策.md

关键词断言（本地 grep -c）:
- Location: 3
- sdk-next: 2
- 热重载: 3
- State.Transformable: 2
- beta: 5
- 定期同步: 3
- opencode2: 2
全部 ≥1，PASS
