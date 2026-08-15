import type { PrototypeDef } from "./types";
import DashboardPrototype from "./dashboard/DashboardPrototype";
import AgentListPrototype from "./agent-list/AgentListPrototype";
import TaskListPrototype from "./task-list/TaskListPrototype";
import ApprovalPrototype from "./approval/ApprovalPrototype";
import FlowListPrototype from "./flow-list/FlowListPrototype";
import FlowDetailPrototype from "./flow-detail/FlowDetailPrototype";
import FlowEditorPrototype from "./flow-editor/FlowEditorPrototype";
import TaskDetailPrototype from "./task-detail/TaskDetailPrototype";
import TaskTracePrototype from "./task-trace/TaskTracePrototype";
import ApprovalDetailPrototype from "./approval-detail/ApprovalDetailPrototype";
import BlueprintMarketPrototype from "./blueprint-market/BlueprintMarketPrototype";
import PluginMarketPrototype from "./plugin-market/PluginMarketPrototype";
import McpServerPrototype from "./mcp-server/McpServerPrototype";
import ToolManagePrototype from "./tool-manage/ToolManagePrototype";
import SkillManagePrototype from "./skill-manage/SkillManagePrototype";
import SecretManagePrototype from "./secret-manage/SecretManagePrototype";
import TriggerManagePrototype from "./trigger-manage/TriggerManagePrototype";
import NamespaceManagePrototype from "./namespace-manage/NamespaceManagePrototype";
import AuditLogPrototype from "./audit-log/AuditLogPrototype";
import AgentCreatePrototype from "./agent-create/AgentCreatePrototype";
import RuntimeManagePrototype from "./runtime-manage/RuntimeManagePrototype";
import SettingsPrototype from "./settings/SettingsPrototype";

/**
 * 原型注册表
 * =====================================================
 * 所有原型页面在此注册后，PrototypeViewer 会自动列出并支持切换。
 *
 * 新增原型页面的步骤：
 *   1. 在 src/prototypes/<name>/ 下创建组件（接收 PrototypeRenderProps）
 *   2. 在本文件中 import 并追加到数组（meta.id 即 URL hash，如 #agent-list）
 * 无需改动 App.tsx / 导航组件。
 */
export const PROTOTYPES: PrototypeDef[] = [
  {
    meta: {
      id: "dashboard",
      name: "平台总览",
      group: "总览",
      description: "平台仪表盘：任务统计、运行中任务、待审批与系统健康",
    },
    Component: DashboardPrototype,
  },
  {
    meta: {
      id: "flow-list",
      name: "流程定义",
      group: "编排",
      description: "流程定义的列表、版本与发布管理",
    },
    Component: FlowListPrototype,
  },
  {
    meta: {
      id: "flow-detail",
      name: "流程详情",
      group: "编排",
      description: "流程概览、版本历史与执行记录",
    },
    Component: FlowDetailPrototype,
  },
  {
    meta: {
      id: "flow-editor",
      name: "流程编排画布",
      group: "编排",
      description: "Agent / 审批 Gate / 并行分支的 DAG 可视化编排",
    },
    Component: FlowEditorPrototype,
  },
  {
    meta: {
      id: "agent-list",
      name: "Agent 管理",
      group: "管理",
      description: "Agent 实例的创建、搜索与状态管理",
    },
    Component: AgentListPrototype,
  },
  {
    meta: {
      id: "agent-create",
      name: "新建 Agent",
      group: "管理",
      description: "Agent 新增表单：基本信息、模型、提示词与工具权限分步配置",
    },
    Component: AgentCreatePrototype,
  },
  {
    meta: {
      id: "task-list",
      name: "任务列表",
      group: "任务",
      description: "编排流水线任务查看与操作",
    },
    Component: TaskListPrototype,
  },
  {
    meta: {
      id: "task-detail",
      name: "任务详情",
      group: "任务",
      description: "任务执行进度、Trace 日志与审批待办",
    },
    Component: TaskDetailPrototype,
  },
  {
    meta: {
      id: "task-trace",
      name: "任务 Trace 全览",
      group: "任务",
      description: "任务执行 Trace 时间线：模型/工具/审批/错误步骤全链路",
    },
    Component: TaskTracePrototype,
  },
  {
    meta: {
      id: "trigger-manage",
      name: "触发器配置",
      group: "任务",
      description: "定时（cron）与 Webhook 触发器的配置管理",
    },
    Component: TriggerManagePrototype,
  },
  {
    meta: {
      id: "approval",
      name: "审批中心",
      group: "审批",
      description: "待审批事项处理与统计",
    },
    Component: ApprovalPrototype,
  },
  {
    meta: {
      id: "approval-detail",
      name: "审批详情",
      group: "审批",
      description: "审批产物预览、审批信息与决策操作",
    },
    Component: ApprovalDetailPrototype,
  },
  {
    meta: {
      id: "blueprint-market",
      name: "蓝图市场",
      group: "生态",
      description: "业务蓝图（流程包）市场：一键安装可复用业务流程",
    },
    Component: BlueprintMarketPrototype,
  },
  {
    meta: {
      id: "plugin-market",
      name: "插件市场",
      group: "生态",
      description: "Agent 与流程的集成插件市场",
    },
    Component: PluginMarketPrototype,
  },
  {
    meta: {
      id: "mcp-server",
      name: "MCP 服务管理",
      group: "生态",
      description: "MCP 服务注册、连接状态与工具自动发现",
    },
    Component: McpServerPrototype,
  },
  {
    meta: {
      id: "tool-manage",
      name: "工具管理",
      group: "生态",
      description: "平台已注册工具的统一管理（来源/风险/Agent 引用）",
    },
    Component: ToolManagePrototype,
  },
  {
    meta: {
      id: "skill-manage",
      name: "Skills 管理",
      group: "生态",
      description: "Agent 可复用的提示词模板与工具绑定技能",
    },
    Component: SkillManagePrototype,
  },
  {
    meta: {
      id: "secret-manage",
      name: "凭证管理",
      group: "设置",
      description: "API Key / Token 等密钥的加密存储与轮换",
    },
    Component: SecretManagePrototype,
  },
  {
    meta: {
      id: "namespace-manage",
      name: "命名空间管理",
      group: "设置",
      description: "多租户命名空间的资源与配额管理",
    },
    Component: NamespaceManagePrototype,
  },
  {
    meta: {
      id: "audit-log",
      name: "审计日志",
      group: "设置",
      description: "资源变更、任务操作与审批决策的不可篡改审计记录",
    },
    Component: AuditLogPrototype,
  },
  {
    meta: {
      id: "runtime-manage",
      name: "运行时管理",
      group: "设置",
      description: "opencode serve 实例管理（多实例/连接/工作区）",
    },
    Component: RuntimeManagePrototype,
  },
  {
    meta: {
      id: "settings",
      name: "全局设置",
      group: "设置",
      description: "平台通用、运行时与已安装插件（Jenkins / GitHub / 通知）配置",
    },
    Component: SettingsPrototype,
  },
];
