# 07 篇新增第 9 章 OpenCodeDriver 抽象层 — 验证证据（2026-08-06）

## 变更
- 文件：docs/agent-platform/07-opencode-v2-调研与架构决策.md（唯一改动，仅追加第 9 章，1-8 章与 frontmatter 未动）
- 第 9 章结构：9.1 决策（v1 起步 v2 就绪）→ 9.2 Driver 接口（TS 代码块）→ 9.3 双实现对比表 → 9.4 角色解析差异 → 9.5 每任务组隔离 → 9.6 v1 实测结论（2026-08-06）→ 9.7 迁移动作清单 → 9.8 预计迁移工作量（10-15%）

## 断言结果（9/9 PASS）
OpenCodeDriver / V1Driver / V2Driver / resolveRole / system / switchAgent / Location / 10-15% / PromptInput 全部命中

## curl 注入（PASS）
`http://localhost:5177/@id/__x00__virtual:md-docs-content` 命中
"/docs/agent-platform/07-opencode-v2-调研与架构决策.md"

## build（PASS）
`md-docs build --out-dir /tmp/site` 退出码 0（2348 modules transformed，构建完成 → /tmp/site）
