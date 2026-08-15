/**
 * 文档注册表（支持层级）
 * =====================================================
 * 文档支持父子层级：父文档可包含多个子文档，左侧以树形展示。
 * 文件位于 public/prd/（由 docs/ 同步而来）。
 * hash 路由：#docs/<id>（顶级）/ #docs/<parentId>/<id>（子文档）。
 */

export interface DocDef {
  /** 唯一标识（用于 URL hash） */
  id: string;
  /** 展示名称（文档列表显示） */
  name: string;
  /** 文档类型标签（如 PRD / ADR / 架构 / 功能模块） */
  kind: string;
  /** 简短描述 */
  description: string;
  /** public/prd/ 下的文件名 */
  file: string;
  /** 父文档 id（顶级文档无此字段） */
  parent?: string;
  /** 列表中的排序 */
  order: number;
}

export const DOCS: DocDef[] = [
  {
    id: "requirements",
    name: "需求规格说明书",
    kind: "PRD",
    description: "Orchestra 平台需求规格：概述、概念、角色、界面原型与全局约束",
    file: "requirements.md",
    order: 1,
  },
  {
    id: "user-guide",
    name: "用户手册",
    kind: "手册",
    description: "面向平台使用者的操作指南：登录、配置、编排、任务、审批与观测",
    file: "user-guide.md",
    order: 2,
  },
  {
    id: "architecture",
    name: "架构设计文档",
    kind: "架构",
    description: "分层架构、技术选型、数据模型、API 与关键时序",
    file: "architecture.md",
    order: 2,
  },
  {
    id: "decisions",
    name: "设计决策记录",
    kind: "ADR",
    description: "开放问题评审与技术选型决策（ADR-001 ~ ADR-014）",
    file: "decisions.md",
    order: 3,
  },
  {
    id: "hld",
    name: "概要设计",
    kind: "设计",
    description: "各功能模块的可行性分析与实现初步方案",
    file: "hld-overview.md",
    order: 4,
  },
  {
    id: "dld",
    name: "详细设计",
    kind: "设计",
    description: "数据库结构设计与具体实现设计",
    file: "dld-overview.md",
    order: 5,
  },
  {
    id: "tech-stack",
    name: "技术栈选型",
    kind: "设计",
    description: "平台技术选型总览：每项选型、理由与替代方案",
    file: "tech-stack.md",
    order: 6,
  },
  {
    id: "deployment",
    name: "部署架构",
    kind: "设计",
    description: "部署拓扑、演进路径、容器化、多节点与 opencode serve 运行时部署",
    file: "deployment.md",
    order: 7,
  },
  {
    id: "development-plan",
    name: "开发计划",
    kind: "计划",
    description: "从 PoC 到 M1/M2/M3 的可执行开发排期与任务分解",
    file: "development-plan.md",
    order: 8,
  },

  /* ---------- 概要设计子文档（挂在 hld 下） ---------- */
  {
    id: "hld-platform",
    name: "4.1 平台基础（概要）",
    kind: "设计",
    description: "资源模型 / 通用资源表 / RBAC 中间件 / 审计 / REST API",
    file: "hld-4.1-platform.md",
    parent: "hld",
    order: 41,
  },
  {
    id: "hld-agent",
    name: "4.2 Agent 管理（概要）",
    kind: "设计",
    description: "AgentSpec / 引用解析 / 模型路由 / 工具白名单校验",
    file: "hld-4.2-agent.md",
    parent: "hld",
    order: 42,
  },
  {
    id: "hld-skill",
    name: "4.3 Skill 管理（概要）",
    kind: "设计",
    description: "不可变版本 / 依赖校验 / prompt 合并与物化",
    file: "hld-4.3-skill.md",
    parent: "hld",
    order: 43,
  },
  {
    id: "hld-flow",
    name: "4.4 流程编排（概要）",
    kind: "设计",
    description: "状态机编译 / DAG 校验 / 版本快照 / Blueprint 打包",
    file: "hld-4.4-flow.md",
    parent: "hld",
    order: 44,
  },
  {
    id: "hld-task",
    name: "4.5 任务执行（概要）",
    kind: "设计",
    description: "任务状态机 / 幂等 / 重试退避 / Worker 租约 / 队列抽象",
    file: "hld-4.5-task.md",
    parent: "hld",
    order: 45,
  },
  {
    id: "hld-approval",
    name: "4.6 人工审批（概要）",
    kind: "设计",
    description: "审批状态机 / resume_context 恢复 / TTL / 工具审批联动",
    file: "hld-4.6-approval.md",
    parent: "hld",
    order: 46,
  },
  {
    id: "hld-runtime",
    name: "4.7 运行时集成（概要）",
    kind: "设计",
    description: "opencode serve 客户端 / SSE 解析 / 会话恢复 / 双层权限",
    file: "hld-4.7-runtime.md",
    parent: "hld",
    order: 47,
  },
  {
    id: "hld-plugin",
    name: "4.8 插件市场（概要）",
    kind: "设计",
    description: "Plugin 资源 / 原生与 MCP 双后端 / 工具发现 / 凭证隔离",
    file: "hld-4.8-plugin.md",
    parent: "hld",
    order: 48,
  },
  {
    id: "hld-observability",
    name: "4.9 可观测性（概要）",
    kind: "设计",
    description: "Trace 事件模型 / 批量落库 / Token 成本 / 指标导出",
    file: "hld-4.9-observability.md",
    parent: "hld",
    order: 49,
  },
  {
    id: "hld-notify",
    name: "4.10 通知与 IM（概要）",
    kind: "设计",
    description: "事件订阅 / 出站 Webhook / 企业微信 / 模板引擎",
    file: "hld-4.10-notify.md",
    parent: "hld",
    order: 50,
  },
  {
    id: "hld-eval",
    name: "4.11 Eval 评估（概要）",
    kind: "设计",
    description: "评估体系概要：golden 数据集 / 评估运行编排 / 评分器 / trace 采样",
    file: "hld-4.11-eval.md",
    parent: "hld",
    order: 51,
  },
  {
    id: "hld-cli",
    name: "CLI（概要）",
    kind: "设计",
    description: "CLI（cliyard）概要设计：可行性分析与初步方案（横切能力）",
    file: "hld-cli.md",
    parent: "hld",
    order: 61,
  },

  /* ---------- 详细设计子文档（挂在 dld 下） ---------- */
  {
    id: "dld-platform",
    name: "4.1 平台基础（详细）",
    kind: "设计",
    description: "resources 通用表 DDL / RBAC 四表 / 审计 / Manifest 解析管线",
    file: "dld-4.1-platform.md",
    parent: "dld",
    order: 51,
  },
  {
    id: "dld-agent",
    name: "4.2 Agent 管理（详细）",
    kind: "设计",
    description: "AgentSpec / ModelEndpoint / 引用解析 / 模型路由 / 工具交集校验",
    file: "dld-4.2-agent.md",
    parent: "dld",
    order: 52,
  },
  {
    id: "dld-skill",
    name: "4.3 Skill 管理（详细）",
    kind: "设计",
    description: "semver 版本 / 依赖双向校验 / prompt 合并与物化",
    file: "dld-4.3-skill.md",
    parent: "dld",
    order: 53,
  },
  {
    id: "dld-flow",
    name: "4.4 流程编排（详细）",
    kind: "设计",
    description: "flow_versions 快照 / 状态机编译 / DAG 环检测 / Blueprint",
    file: "dld-4.4-flow.md",
    parent: "dld",
    order: 54,
  },
  {
    id: "dld-task",
    name: "4.5 任务执行（详细）",
    kind: "设计",
    description: "tasks/task_messages DDL / 八态状态机 / 租约 / 幂等键 / 队列抽象",
    file: "dld-4.5-task.md",
    parent: "dld",
    order: 55,
  },
  {
    id: "dld-approval",
    name: "4.6 人工审批（详细）",
    kind: "设计",
    description: "approvals DDL / 审批状态机 / resume_context / TTL / permission 联动",
    file: "dld-4.6-approval.md",
    parent: "dld",
    order: 56,
  },
  {
    id: "dld-runtime",
    name: "4.7 运行时集成（详细）",
    kind: "设计",
    description: "RuntimeInstance / opencode 客户端封装 / SSE 解析 / 会话恢复",
    file: "dld-4.7-runtime.md",
    parent: "dld",
    order: 57,
  },
  {
    id: "dld-plugin",
    name: "4.8 插件市场（详细）",
    kind: "设计",
    description: "Plugin/McpServer 资源 / secrets 加密表 / MCP 工具发现 / SSRF",
    file: "dld-4.8-plugin.md",
    parent: "dld",
    order: 58,
  },
  {
    id: "dld-observability",
    name: "4.9 可观测性（详细）",
    kind: "设计",
    description: "task_trace_events/task_logs DDL / 批量写入 / 成本聚合 / 指标",
    file: "dld-4.9-observability.md",
    parent: "dld",
    order: 59,
  },
  {
    id: "dld-notify",
    name: "4.10 通知与 IM（详细）",
    kind: "设计",
    description: "NotificationRule / notify_deliveries / 出站 HMAC / 企业微信卡片",
    file: "dld-4.10-notify.md",
    parent: "dld",
    order: 60,
  },
  {
    id: "dld-eval",
    name: "4.11 Eval 评估（详细）",
    kind: "设计",
    description: "eval_datasets/eval_runs/eval_case_results DDL / 评估运行编排 / 评分器 / trace 采样",
    file: "dld-4.11-eval.md",
    parent: "dld",
    order: 61,
  },
  {
    id: "dld-cli",
    name: "CLI（详细）",
    kind: "设计",
    description: "CLI（cliyard）详细设计：specs 目录/_auth.yaml/资源 YAML/分发（横切能力）",
    file: "dld-cli.md",
    parent: "dld",
    order: 71,
  },
  {
    id: "dld-agent-chat",
    name: "4.13 任务级 Agent 对话（详细）",
    kind: "设计",
    description: "task_chat_messages DDL / WaitingForUserInput 状态机 / 消息注入与动作协议 / 产物库 / SSE 代理",
    file: "dld-4.13-agent-chat.md",
    parent: "dld",
    order: 62,
  },

  /* ---------- 功能模块子文档（挂在 requirements 下） ---------- */
  {
    id: "req-platform",
    name: "4.1 平台基础与治理",
    kind: "模块",
    description: "命名空间 / RBAC / 审计 / API 与 CLI / 资源声明式管理",
    file: "req-4.1-platform.md",
    parent: "requirements",
    order: 11,
  },
  {
    id: "req-agent",
    name: "4.2 Agent 管理",
    kind: "模块",
    description: "Agent 配置 / 模型路由 / 工具权限 / 技能引用 / 委托",
    file: "req-4.2-agent.md",
    parent: "requirements",
    order: 12,
  },
  {
    id: "req-skill",
    name: "4.3 Skill 管理",
    kind: "模块",
    description: "技能包创建 / 版本 / 依赖 / 市场",
    file: "req-4.3-skill.md",
    parent: "requirements",
    order: 13,
  },
  {
    id: "req-flow",
    name: "4.4 流程编排",
    kind: "模块",
    description: "DAG 编排 / 条件路由 / 并行汇合 / 循环 / 审批关卡 / 版本",
    file: "req-4.4-flow.md",
    parent: "requirements",
    order: 14,
  },
  {
    id: "req-task",
    name: "4.5 任务执行与触发",
    kind: "模块",
    description: "手动 / 定时 / Webhook 触发 / 重试 / Worker 分布式执行",
    file: "req-4.5-task.md",
    parent: "requirements",
    order: 15,
  },
  {
    id: "req-approval",
    name: "4.6 人工审批",
    kind: "模块",
    description: "审批状态机 / 精确恢复 / 打回循环 / TTL / 工具级审批",
    file: "req-4.6-approval.md",
    parent: "requirements",
    order: 16,
  },
  {
    id: "req-runtime",
    name: "4.7 运行时集成",
    kind: "模块",
    description: "opencode serve 对接 / SSE 事件流 / 会话恢复 / 权限联动",
    file: "req-4.7-runtime.md",
    parent: "requirements",
    order: 17,
  },
  {
    id: "req-plugin",
    name: "4.8 插件市场",
    kind: "模块",
    description: "插件安装 / MCP 协议接入 / 凭证隔离 / 沙箱",
    file: "req-4.8-plugin.md",
    parent: "requirements",
    order: 18,
  },
  {
    id: "req-observability",
    name: "4.9 可观测性",
    kind: "模块",
    description: "任务 Trace / 日志 / Token 成本 / 指标 / 审计检索",
    file: "req-4.9-observability.md",
    parent: "requirements",
    order: 19,
  },
  {
    id: "req-notify",
    name: "4.10 通知与 IM",
    kind: "模块",
    description: "出站 Webhook / 企业微信 / 飞书钉钉 / IM 发起任务",
    file: "req-4.10-notify.md",
    parent: "requirements",
    order: 20,
  },
  {
    id: "req-eval",
    name: "4.11 Eval 评估",
    kind: "模块",
    description: "golden 数据集 / 评估运行 / 评分维度 / 评估报告",
    file: "req-4.11-eval.md",
    parent: "requirements",
    order: 21,
  },
  {
    id: "req-auth",
    name: "4.12 认证与用户管理",
    kind: "模块",
    description: "密码登录 / 存量用户兼容（首次登录设密码）/ 用户管理与角色分配 / /me",
    file: "req-4.12-auth.md",
    parent: "requirements",
    order: 22,
  },
  {
    id: "req-agent-chat",
    name: "4.13 任务级 Agent 对话",
    kind: "模块",
    description: "注入式多轮对话 / SSE 流式 / WaitingForUserInput / 动作协议 / 任务级产物库 / 已完成 agent 持续对话",
    file: "req-4.13-agent-chat.md",
    parent: "requirements",
    order: 23,
  },
];

/** 按 order 排序 */
export const SORTED_DOCS = [...DOCS].sort((a, b) => a.order - b.order);

/** 顶级文档（无 parent） */
export const ROOT_DOCS = SORTED_DOCS.filter((d) => !d.parent);

/** 指定父文档下的子文档 */
export function childrenOf(parentId: string): DocDef[] {
  return SORTED_DOCS.filter((d) => d.parent === parentId);
}

/** 按 id 查找文档 */
export function findDoc(id: string): DocDef | undefined {
  return DOCS.find((d) => d.id === id);
}

/** 文档在树中的层级路径（如 ["requirements", "req-flow"]） */
export function docPath(id: string): string[] {
  const doc = findDoc(id);
  if (!doc) return [];
  if (!doc.parent) return [doc.id];
  const parent = findDoc(doc.parent);
  return parent ? [parent.id, doc.id] : [doc.id];
}
