# 工具权限模型同步到 PRD（03/04/07 篇）验证证据

日期：2026-08-06
范围：仅改 `docs/agent-platform/` 下 04 / 03 / 07 三篇，原型与 01/02/05/06 未动。

## 改动清单

### 04 篇 `04-功能需求-Agent与产出物.md`
- **FR-35 工具配置细化**：工具配置 = 启用开关 + 每工具独立配置权限 effect（allow 允许 / ask 每次确认 / deny 禁止）；工具名即权限 action（如 `jenkins-build`），支持通配符批量（如 `jenkins-*`）。
- **新增 FR-48 工具权限**（编号续 FR-47 后）：Agent 工具权限按「工具（action）× effect（allow/ask/deny）」逐工具配置；权限点 = 工具名（开放命名空间，非固定枚举）；有副作用工具（构建/部署/写操作）默认 ask；来源徽章（内置/自定义/MCP）；支持通配符。
- **FR-36 权限范围补充**：明确与工具权限的关系——工具权限 = 每工具 effect；权限范围 = 资源范围；两者正交、叠加生效。
- 配置面板说明补 FR-35 / FR-48 对应。
- FR 编号连续：FR-30~48 全部存在。

### 03 篇 `03-功能需求-任务与群聊协作.md`
- **FR-23 角色权限矩阵补充**：「技能工具」资源行含工具级权限——每个工具 = 权限点 action，矩阵按工具粒度授权；工具内部执行策略由 Agent 侧逐工具配置（effect 取值 allow/ask/deny，支持通配符，见 04 篇 FR-48）。
- FR-01~24 连续无缺（FR-48 仅交叉引用）。

### 07 篇 `07-opencode-v2-调研与架构决策.md`
- **新增 3.1 小节「工具权限模型（PermissionV2）」**：
  - 权限点来源：内置基础能力（bash/read/edit）是枚举，但每工具注册时自动以其名字成为新权限点（开放命名空间，源码 `action: name`），非固定枚举。
  - effect ∈ {allow, ask, deny} + 通配符（Wildcard，`jenkins-*`）。
  - 与 opencode PermissionV2 对齐：action 自由字符串（schema `Schema.String` 非枚举）。
  - 权限链路：创建工具确定能力+默认权限 → agent-config 每工具配 effect → opencode 运行时执行（Permission 交互请求正式化）。

## 验证结果

### curl（md-docs 服务 5177）
```
KEY OK: 04-功能需求-Agent与产出物.md
KEY OK: 03-功能需求-任务与群聊协作.md
KEY OK: 07-opencode-v2-调研与架构决策.md
```

### 编号连续性
- 04 篇 FR 编号去重排序：FR-30~FR-48 连续齐全。
- 03 篇 FR 编号去重排序：FR-01~FR-24 连续齐全。

### grep 关键词断言（3 篇命中数）
| 关键词 | 命中 |
|--------|------|
| 权限点 | 3/3 |
| effect | 3/3 |
| allow | 3/3 |
| ask | 3/3 |
| deny | 3/3 |
| 通配符 | 3/3 |
| FR-48 | 3/3 |
| action: name（07 篇源码依据） | 2 |
| Schema.String（07 篇） | 1 |

### md-docs build
```
BUILD EXIT: 0 → /tmp/site
```
