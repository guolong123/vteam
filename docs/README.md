# docs — vteam 文档站

本目录收录 **vteam（虚拟团队 AI 协作平台）** 的交付物文档，可作为 md-docs 文档站渲染（左侧导航按目录结构浏览）。

## 内容

- **设计文档**：`docs/agent-platform/`，20+ 篇从背景、PRD 到架构、API、协议、验收的完整设计序列
- **原型页面**：`docs/agent-platform/prototypes/`，19 个 HTML 原型（登录 / 任务 / 群聊 / 私聊 / Issue / Agent / 模型 / Worker 管理等），`_shared/` 存放共享组件
- **测试用例**：`docs/test-cases/`，覆盖认证/用户/角色、项目/任务、群聊/实时、Agent/模型、技能/工具/MCP、Worker/产出物等模块
- **测试报告**：`docs/test-reports/`

## 设计文档索引（agent-platform/）

推荐阅读顺序（编号即演进顺序）：

| 编号 | 文档 | 要点 |
|------|------|------|
| 01 | [背景与目标](agent-platform/01-背景与目标.md) | 项目背景、目标与范围 |
| 03 | [功能需求：任务与群聊协作](agent-platform/03-功能需求-任务与群聊协作.md) | 任务驱动、群聊协作需求 |
| 04 | [功能需求：Agent 与产出物](agent-platform/04-功能需求-Agent与产出物.md) | Agent、产出物与文档库 |
| 07 | [opencode v2 调研与架构决策](agent-platform/07-opencode-v2-调研与架构决策.md) | 执行引擎选型与决策 |
| 08 | [平台架构设计](agent-platform/08-平台架构设计.md) | 三端架构与模块划分 |
| 09 | [API 设计](agent-platform/09-API设计.md) | 后端 API 契约 |
| 13 | [任务状态机与全生命周期](agent-platform/13-任务状态机与全生命周期.md) | 任务状态流转与验收 |
| 14 | [Agent 配置与虚拟团队模型](agent-platform/14-Agent配置与虚拟团队模型.md) | 角色、实例与团队模型 |
| 16 | [内置 Agent 角色与提示词库](agent-platform/16-内置Agent角色与提示词库.md) | 五类角色身份与四方向提示词 |
| 21 | [平台 MCP Server 设计方案](agent-platform/21-平台MCP-Server设计方案.md) | keta-platform MCP 工具设计 |

另有：[02 用户与场景](agent-platform/02-用户与场景.md)、[05 非功能与验收边界](agent-platform/05-非功能与验收边界.md)、[06 交互与页面设计](agent-platform/06-交互与页面设计.md)、[10 群聊与消息机制](agent-platform/10-群聊与消息机制.md)、[11 资源与注册机制](agent-platform/11-资源与注册机制（工具skills-mcp）.md)、[12 产出物协议与文档库](agent-platform/12-产出物协议与文档库.md)、[15 数据模型细化（ER图）](agent-platform/15-数据模型细化（ER图）.md)、[17 仓库权限与凭证机制](agent-platform/17-仓库权限与凭证机制.md)、[18 原型审计报告](agent-platform/18-原型审计报告.md)、[18 推进计划](agent-platform/18-推进计划（分阶段实施）.md)、[19 worker-agent 任务关系梳理](agent-platform/19-worker-agent-任务关系梳理.md)、[20 E2E 验证问题清单](agent-platform/20-E2E验证问题清单.md)

## 技术要点

基于 opencode 的多 Agent 协作平台：任务编排、角色化 Agent 团队、并行探索、群聊/私聊协作、MCP 工具与产出物聚合。
