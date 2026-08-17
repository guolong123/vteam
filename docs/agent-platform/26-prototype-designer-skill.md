---
name: prototype-designer
description: 原型页面设计技能——按平台原型 DSL 规范编写 prototype.json 并提交，文档站「原型」tab 自动渲染（无需改代码）。适用于任务需要产出原型/UI 稿/页面示意时。
version: 1.0.0
allowed-tools:
  - task_context
  - submit_artifact
  - read_file
---

# 原型设计（Prototype Designer）

## 目标

为当前任务设计并提交**可渲染的原型页面**：按平台 DSL 规范编写 `prototype.json`，经 `submit_artifact` 提交后，文档站「原型」tab 自动出现并渲染。**无需改动任何代码、无需重新部署。**

## 工作流程

1. **分析需求**：用 `task_context` 获取任务标题/描述/背景，明确原型要展示什么（业务页面、管理界面、流程示意等）。
2. **设计结构**：规划页面数量（`pages`，通常 1-3 页）与每页区块（`sections`，自上而下布局）。
3. **编写 DSL**：按下方规范生成 JSON 文件（文件名 `<英文短名>.prototype.json`）。
4. **自检**：JSON 语法合法、`id/name` 必填、section `type` 均为规范内组件、数据用演示值。
5. **提交**：`submit_artifact`（type=file）提交原型文件（见「提交方式」）。
6. **确认**：可经 `read_file` 复查已提交文件内容；文档站渲染失败时检查 JSON 合法性与 type 拼写。

## DSL 规范（v1）

文件为 UTF-8 JSON，结构：

```jsonc
{
  "id": "proto-name",          // 必填：唯一英文短名（kebab-case，= 文件名去后缀）
  "name": "原型显示名",         // 必填：文档站列表/页头展示名
  "description": "一句话说明",  // 可选
  "pages": [                   // 必填：至少 1 页
    {
      "title": "页面标题",      // 页面 tab 名
      "sections": [             // 自上而下区块，至少 1 个
        { "type": "...", ... }
      ]
    }
  ]
}
```

### 区块组件（section.type 取值）

| type | 字段 | 说明 |
|---|---|---|
| `header` | `title`, `subtitle?` | 页面标题区（大标题 + 副标题） |
| `stats` | `items: [{label, value, trend?}]` | 统计卡片行（数字指标） |
| `cards` | `items: [{title, description?, status?, badge?}]` | 卡片列表（status: success/warning/danger/info） |
| `table` | `columns: [{key, label}], rows: [{key: 值}]` | 数据表格（columns 定义列，rows 为对象数组） |
| `list` | `items: [{title, description?}]` | 列表条目 |
| `form` | `fields: [{label, type, options?, placeholder?}], submitLabel?` | 表单（type: text/textarea/select；select 需 options 数组） |
| `tabs` | `tabs: [{label, sections: [...]}]` | 页签分组（sections 可嵌套任意组件） |
| `markdown` | `content` | Markdown 文本（支持标题/列表/表格等） |
| `nav` | `items: [{label, active?}]` | 侧边导航示意（active=true 高亮当前项） |

### 规范约束

- **必须**：`id`、`name` 必填；`pages[].sections` 至少 1 个；JSON 严格合法（渲染器解析失败则原型不可用）。
- **未知 type 不要用**：渲染器对未知 type 显示占位卡片（"未支持的组件"），不会崩溃但视觉差。
- **数据为演示值**：原型是静态展示/演示，数据写示例值（如"1286""进行中"），不要留空。
- **交互仅客户端**：支持页签切换、tab 切换、表单输入；不支持真实提交/写操作/服务端请求。
- **命名**：`id` 用英文 kebab-case（`cliyard-dashboard`）；`name` 可用中文。
- **嵌套**：`tabs` 的 sections 可嵌套任意组件（含 tabs 外的全部类型）。

### 示例（最小完整原型）

```json
{
  "id": "task-overview",
  "name": "任务总览",
  "description": "任务进度与统计概览",
  "pages": [
    {
      "title": "总览",
      "sections": [
        { "type": "header", "title": "任务总览", "subtitle": "当前迭代演示" },
        { "type": "stats", "items": [
          { "label": "总任务", "value": "1286" },
          { "label": "运行中", "value": "8", "trend": "+2" },
          { "label": "待审批", "value": "6" }
        ]},
        { "type": "cards", "items": [
          { "title": "前端重构", "description": "进行中的迭代", "status": "info", "badge": "v2.1" }
        ]},
        { "type": "table", "columns": [
          { "key": "name", "label": "任务" },
          { "key": "owner", "label": "负责人" },
          { "key": "status", "label": "状态" }
        ], "rows": [
          { "name": "文档站改造", "owner": "开发者-1", "status": "进行中" },
          { "name": "MCP 接入", "owner": "开发者-2", "status": "待验收" }
        ]}
      ]
    }
  ]
}
```

## 提交方式

- **文件名**：`<id>.prototype.json`（与 DSL `id` 一致，如 `task-overview.prototype.json`）。
- **fileRef**：原型文件在工作目录的路径（绝对路径，如 `/data/keta-worker/<任务工作目录>/task-overview.prototype.json`；文件需先写入工作目录）。
- **调用**：

```
submit_artifact { taskId: <任务ID>, selfInstanceId: <你的实例ID>, type: "file", title: "<原型名>", fileRef: "<工作目录>/<id>.prototype.json" }
```

提交成功后，文档站「原型」tab 自动出现该原型（列表按名称展示，点击渲染）。

## 常见错误

| 错误 | 规避 |
|---|---|
| JSON 语法错误（引号/逗号） | 提交前严格校验 JSON（可用 read_file 复查） |
| `type` 拼写错误/未知值 | 只用规范内 9 种 type |
| `id` 含中文/大写 | 用英文 kebab-case |
| 数据留空/undefined | 全部写演示值 |
| 试图做真实交互（提交/请求） | 原型仅静态展示，交互仅 tab/表单输入 |
