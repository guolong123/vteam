# 18-推进计划（分阶段实施）验证证据

## 交付文件
- `docs/agent-platform/18-推进计划（分阶段实施）.md`（581 行，10 节）

## 内容要求核对
| 要求 | 状态 |
|------|------|
| frontmatter（title/id/order/kind） | ✅ |
| 10 节（定位基线/总体策略/核心约束/Phase 0~5/里程碑） | ✅ |
| 阶段总览表 Phase 0~5 × 里程碑 | ✅ §2.1 |
| mermaid ≥2 块 | ✅ 2 块（阶段依赖 flowchart + 里程碑 gantt） |
| 前后端并行策略（OpenAPI 契约锚点 + SSE 基座先行） | ✅ §2.3 |
| 核心约束：前端与原型一致（styles.ts/components.tsx/nav.tsx 零改动） | ✅ §3.1 |
| 技术栈锁定 08 篇 §2 / 数据模型 15 篇 20 表 | ✅ §3.2/§3.3 |
| 每阶段功能性验收（M1~M5） | ✅ §1.3/§10.3 |
| 只新建 18 篇，未改 01-17 | ✅ |

## 验证命令与结果
```bash
# md-docs build 退出码 0
md-docs build --out-dir /tmp/aiagents-site  →  BUILD_EXIT=0

# dev 服务注入含 18 key
md-docs --no-open --port 5199
curl http://localhost:5199/@id/__x00__virtual:md-docs-content | grep '推进计划（分阶段实施）'  →  命中 2 次

# grep 断言
mermaid 块数      : 2
前后端并行        : 5
原型一致          : 13
styles.ts         : 5
里程碑            : 16
Phase 1           : 18
功能性验收        : 2
components.tsx    : 4
M0/M5             : 9 / 13
```

## 结论
- md-docs build 退出码 **0**
- dev 服务内容注入含 **18 篇 key**
- 全部 grep 断言通过（「功能性验收」已补入 §1.3 标题）
- 5 个 mermaid ≥2 块（实际 2 块）