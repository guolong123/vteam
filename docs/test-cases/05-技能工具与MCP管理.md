---
title: 技能工具与MCP管理测试用例
id: testcases-skills-tools-mcp
order: 5
kind: 测试用例
description: 技能、工具注册与 MCP 服务器管理功能测试用例（正向+反向）
---

# 技能工具与MCP管理测试用例

## 1. 模块范围与环境

本文档覆盖三个模块：**技能管理（Skills）**、**工具管理（Tools）**、**MCP 服务器管理（McpServers）**，对应需求 `docs/agent-platform/03-功能需求-任务与群聊协作.md` 的 FR-27、`11-资源与注册机制（工具skills-mcp）.md` 全篇（工具注册 / 技能注册 / MCP 接入）、`06-交互与页面设计.md` §2.12 技能与工具页、`09-API设计.md` §3.8 SkillsTools。实现位于 `server/src/skills`、`server/src/tools`、`server/src/mcp-servers`。

**测试环境**

| 项 | 值 |
|----|----|
| Web 入口 | http://192.168.10.78:13001（侧边栏「技能工具」导航进入技能与工具页） |
| API 入口 | http://192.168.10.78:13000/api/v1 |
| 管理员 | `admin` / `admin123`（角色 admin，`permissions:{all:true}`） |
| Seed 成员 | `seed-member` / `Admin@123456`（角色 member，`permissions:{all:false}`，只读） |
| 认证方式 | JWT Bearer（`Authorization: Bearer <accessToken>`），全局前缀 `/api/v1` |
| 预置内置工具 | `bash`、`read`、`edit`、`write`、`grep`、`glob`（seed 写入，source=builtin，execution=code，id 形如 `tl_builtin_bash`） |

**冒烟命令**（登录拿 token）：

```bash
curl -X POST http://192.168.10.78:13000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# 返回 {accessToken, refreshToken, user}
```

**实现与需求差异说明**（用例预期均以**实际实现为准**，已在上线环境实测验证）：

1. `09 §3.8` `POST /tools` 请求要点为 `{name, execution, schema?, initCommand?, mcpServer?}`，**实际实现新增必填 `action` 字段**（工具调用标识，独立于展示名 name，规则 `^[a-z0-9][a-z0-9-_.]*$`），另支持可选 `enabled`（默认 true）。`source` 不传入，由 service 推导：`execution=mcp → source=mcp`，其余 → `custom`。
2. `mcpServer` 在实现 DTO 中为**可选**（注释声称「execution=mcp 时必填」，但 class-validator 未做条件必填）——`execution=mcp` 不带 `mcpServer` 仍可创建（实测 201，`mcpServer=null`）。用例按此编写并标注为待改进项。
3. `09 §3.8` 技能端点仅有 `POST/GET /skills` 与 `PATCH /skills/:id/status`，**实际实现另有** `GET /skills/:id/content`（worker 注入拉取 SKILL.md 全文，T4b）与 `PATCH /skills/:id`（编辑 name/description/content，UX-15，JSON body）。本文档按实现收录。
4. 技能写端点鉴权为 **PermissionGuard**（`skills.create` / `skills.edit` 权限点，越权 → 403 `FORBIDDEN_PERMISSION`）；工具、MCP 写端点鉴权为 **AdminGuard**（越权 → 403 `FORBIDDEN_ADMIN`）。两类守卫对无 token 均返回 401 `AUTH_UNAUTHORIZED`。
5. 技能、工具**均无 DELETE 端点**（删除需求由 `enabled=false` 停用替代）；对工具路径发 DELETE 实测返回 **404**（路由不存在）。MCP 服务器**有物理 DELETE**。
6. `PATCH /tools/:id` 仅允许 `schema/initCommand/enabled`；请求体携带 `name/action` 等字段时被全局 `ValidationPipe(whitelist:true)` **静默剥离**（实测 200 但字段不生效）。
7. 技能名规则：`^[a-z0-9]+(-[a-z0-9]+)*$`（小写字母数字 + 中划线分段，≤64 字符）；工具 action 与 MCP name 规则：`^[a-z0-9][a-z0-9-_.]*$`（首字符小写字母/数字，可含 `-_.`）。

**通用错误码**

| code | 状态码 | 场景 |
|------|--------|------|
| `SKILL_FILE_REQUIRED` | 400 | 技能上传缺 file 字段 |
| `SKILL_FRONTMATTER_INVALID` | 400 | SKILL.md frontmatter 缺失/未闭合/name 缺省或格式非法 |
| `SKILL_NAME_EXISTS` | 409 | 技能 name 重复（create/update） |
| `SKILL_NOT_FOUND` | 404 | 技能不存在（content/update/status） |
| `SKILL_UPDATE_EMPTY` | 400 | PATCH /skills/:id 无可更新字段 |
| `TOOL_ACTION_EXISTS` | 409 | 工具 action 重复 |
| `TOOL_NOT_FOUND` | 404 | 工具不存在 |
| `MCP_SERVER_NAME_EXISTS` | 409 | MCP 服务器 name 重复 |
| `MCP_SERVER_INVALID_CONFIG` | 400 | local/remote 配置非法 |
| `MCP_SERVER_NOT_FOUND` | 404 | MCP 服务器不存在 |
| `FORBIDDEN_ADMIN` | 403 | 非管理员访问 AdminGuard 端点 |
| `FORBIDDEN_PERMISSION` | 403 | 缺少权限点（skills.create/skills.edit） |
| `AUTH_UNAUTHORIZED` | 401 | 未认证/无效 token/账号被禁用 |

---

## 2. 技能管理用例（TC-SKL）

> 技能管理端点：`POST /skills`（multipart 上传，默认停用）、`GET /skills`（enabled 过滤 + name 搜索 + 分页）、`GET /skills/:id/content`（全文）、`PATCH /skills/:id`（编辑元信息/内容）、`PATCH /skills/:id/status`（启停，替代删除）。读写鉴权：读 `skills.view`（成员只读可见已启用），写 `skills.create` / `skills.edit`。

### 2.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-SKL-001 | 上传合法 SKILL.md 注册技能（默认停用） | 正向 | P0 | admin accessToken；`tc-skill-<ts>` 名称可用 | 1. 构造 `skill.md`：`---\nname: tc-skill-<ts>\ndescription: 测试技能\nversion: 1.0.0\nallowed-tools:\n  - bash\n  - read\n---\n# 技能正文`<br>2. `POST /api/v1/skills`，multipart form-data 字段 `file=@skill.md;type=text/markdown` | 1. 返回 `201 Created`，响应为技能对象：`{id: "sk_<数字>", name: "tc-skill-<ts>", description, enabled: false, fileMeta: {name, description, version, allowedTools, originalname, size, mimetype}}`<br>2. `enabled` 固定为 `false`（默认停用），落库 `content` 为 SKILL.md 原文 |
| TC-SKL-002 | 技能列表：管理员全量查看 + 分页 | 正向 | P0 | admin accessToken；已存在若干技能（含已启用与已停用） | 1. `GET /api/v1/skills?page=1&pageSize=20` | 1. 返回 `200 OK`，结构为 `{items, total, page, pageSize}`<br>2. `total` 包含全部技能（含停用），`items` 按 createdAt 升序 |
| TC-SKL-003 | 技能列表：enabled=true 只返回启用技能 | 正向 | P1 | admin accessToken；存在至少一个已启用技能 | 1. `GET /api/v1/skills?enabled=true` | 1. 返回 `200 OK`，`items` 全部 `enabled=true`；`enabled=false` 技能不出现 |
| TC-SKL-004 | 技能列表：name 模糊搜索 | 正向 | P1 | admin accessToken；存在技能 `tc-skill-<ts>` | 1. `GET /api/v1/skills?name=tc-skill` | 1. 返回 `200 OK`，`items` 中技能 name 均 `contains "tc-skill"`（大小写敏感 contains） |
| TC-SKL-005 | 拉取技能 SKILL.md 全文（worker 注入数据源） | 正向 | P0 | admin accessToken；已存在技能 `sk_<id>` | 1. `GET /api/v1/skills/sk_<id>/content` | 1. 返回 `200 OK`，响应为 `{id, name, content}`<br>2. `content` 与上传原文完全一致（含 `---` frontmatter 块），供 worker 写盘注入 |
| TC-SKL-006 | 启用技能（PATCH status enabled=true） | 正向 | P0 | admin accessToken；存在停用技能 `sk_<id>` | 1. `PATCH /api/v1/skills/sk_<id>/status`，body：`{"enabled":true}` | 1. 返回 `200 OK`，响应技能对象 `enabled=true`<br>2. 再次 `GET /skills?enabled=true` 可见该技能（启用的技能可供 Agent 勾选，FR-34） |
| TC-SKL-007 | 停用技能（enabled=false 替代删除） | 正向 | P0 | admin accessToken；存在启用技能 `sk_<id>` | 1. `PATCH /api/v1/skills/sk_<id>/status`，body：`{"enabled":false}` | 1. 返回 `200 OK`，响应技能对象 `enabled=false`<br>2. 技能仍在列表中（无物理删除），但成员侧 `GET /skills`（强制 enabled=true）不再可见该技能 |
| TC-SKL-008 | 编辑技能描述并同步重写 frontmatter | 正向 | P1 | admin accessToken；存在技能 `sk_<id>` | 1. `PATCH /api/v1/skills/sk_<id>`，body：`{"description":"新描述"}`<br>2. `GET /api/v1/skills/sk_<id>/content` 核对全文 | 1. 返回 `200 OK`，响应 `description="新描述"`<br>2. content frontmatter 中的 `description` 字段被同步重写为「新描述」（维持「DB 列 = content frontmatter」不变量） |
| TC-SKL-009 | 编辑技能全文内容并反向同步列 | 正向 | P1 | admin accessToken；存在技能 `sk_<id>` | 1. `PATCH /api/v1/skills/sk_<id>`，body：`{"content":"---\nname: tc-skill-renamed-<ts>\ndescription: 内容变更\n---\n# 新正文"}`<br>2. `GET /skills` 核对列表 | 1. 返回 `200 OK`，响应 `name`/`description` 反向取新 content 的 frontmatter 解析值（name 变为 `tc-skill-renamed-<ts>`）<br>2. content 原文按新值落库，列表展示与注入原文一致 |

### 2.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-SKL-010 | 上传技能：请求未携带 file 字段 | 反向 | P0 | admin accessToken | 1. `POST /api/v1/skills`（不带 multipart 的 file 字段） | 1. 返回 `400 Bad Request`，`code=SKILL_FILE_REQUIRED`，message「缺少 file 文件（SKILL.md 技能包）」<br>2. 不创建任何技能 |
| TC-SKL-011 | 上传技能：文件非 `---` 开头（非技能包） | 反向 | P0 | admin accessToken | 1. 构造无 frontmatter 的 `bad.md`（首行 `not-frontmatter`）<br>2. `POST /api/v1/skills`，字段 `file=@bad.md` | 1. 返回 `400 Bad Request`，`code=SKILL_FRONTMATTER_INVALID`，message 含「文件必须以 --- 开头的 YAML frontmatter」 |
| TC-SKL-012 | 上传技能：frontmatter 块未闭合 | 反向 | P1 | admin accessToken | 1. 构造 `unclosed.md`：`---\nname: tc-unclosed\n`（无结束 `---`）<br>2. `POST /api/v1/skills`，字段 `file=@unclosed.md` | 1. 返回 `400 Bad Request`，`code=SKILL_FRONTMATTER_INVALID`，message「未找到 frontmatter 结束标记 ---」 |
| TC-SKL-013 | 上传技能：frontmatter 缺 name 或 name 非法格式 | 反向 | P0 | admin accessToken | 1.（a）构造无 name 的 SKILL.md 上传<br>2.（b）构造 `name: Bad-Name`（含大写）上传 | 1. 两种情况均返回 `400 Bad Request`，`code=SKILL_FRONTMATTER_INVALID`（a 报「缺少必填字段 name」；b 报「不符合命名规范（小写字母数字，中划线分段）」）<br>2. 不创建技能 |
| TC-SKL-014 | 上传技能：name 与既有技能重复 | 反向 | P0 | admin accessToken；已存在技能 `tc-skill-<ts>` | 1. 构造 frontmatter name 为 `tc-skill-<ts>` 的 SKILL.md<br>2. `POST /api/v1/skills` 上传 | 1. 返回 `409 Conflict`，`code=SKILL_NAME_EXISTS`，message「技能名称「tc-skill-<ts>」已存在」<br>2. 不重复创建 |
| TC-SKL-015 | 启停技能：enabled 为非法布尔值 | 反向 | P1 | admin accessToken；存在技能 `sk_<id>` | 1. `PATCH /api/v1/skills/sk_<id>/status`，body：`{"enabled":"yes"}`（字符串）<br>2.（变体）body 缺 enabled 字段 | 1. 返回 `400 Bad Request`（`@IsBoolean` 校验失败，message 数组含约束信息）<br>2. 技能状态不变 |
| TC-SKL-016 | 启停技能：技能不存在 | 反向 | P1 | admin accessToken | 1. `PATCH /api/v1/skills/sk_9999999999/status`，body：`{"enabled":true}` | 1. 返回 `404 Not Found`，`code=SKILL_NOT_FOUND`，message「技能 sk_9999999999 不存在」 |
| TC-SKL-017 | 编辑技能：请求体为空 | 反向 | P1 | admin accessToken；存在技能 `sk_<id>` | 1. `PATCH /api/v1/skills/sk_<id>`，body：`{}` | 1. 返回 `400 Bad Request`，`code=SKILL_UPDATE_EMPTY`，message「无可更新字段（name/description/content 至少提供一个）」 |
| TC-SKL-018 | 编辑技能：技能不存在 | 反向 | P1 | admin accessToken | 1. `PATCH /api/v1/skills/sk_9999999999`，body：`{"description":"x"}` | 1. 返回 `404 Not Found`，`code=SKILL_NOT_FOUND` |
| TC-SKL-019 | 技能列表：enabled 过滤参数非法 | 反向 | P1 | admin accessToken | 1. `GET /api/v1/skills?enabled=xyz` | 1. 返回 `400 Bad Request`（`enabled` Transform 后非布尔，`@IsBoolean` 校验失败） |
| TC-SKL-020 | 成员只读与越权、未认证 | 反向 | P0 | seed-member token；admin 角色下的停用技能 | 1. `GET /api/v1/skills` 用 seed-member token<br>2. `POST /api/v1/skills` 用 seed-member token（带合法文件）<br>3. `POST /api/v1/skills` 不带 Authorization 头 | 1. 步骤 1 返回 `200 OK`，但**强制只返回 enabled=true 的技能**（停用技能被过滤，实测 total=0）<br>2. 步骤 2 返回 `403 Forbidden`，`code=FORBIDDEN_PERMISSION`，message「缺少 skills.create 权限」<br>3. 步骤 3 返回 `401 Unauthorized`，`code=AUTH_UNAUTHORIZED` |
| TC-SKL-021 | 技能与工具页：技能上传与启停交互（Web） | 正向 | P0 | 浏览器以 admin/admin123 登录进入平台 | 1. 侧边栏点击「技能工具」进入技能与工具页<br>2. 在「技能」页签点击上传，选择合法 SKILL.md<br>3. 上传成功后对技能行点击「启用/停用」开关 | 1. 页面展示技能/工具两个页签（§2.12）<br>2. 上传成功出现新技能行，状态为「停用」（默认停用），带来源与描述<br>3. 切换开关后行状态即时变为「启用/停用」，刷新后状态保持 |

---

## 3. 工具管理用例（TC-TOL）

> 工具管理端点：`GET /tools`（source/execution/enabled 过滤 + name 搜索 + 分页）、`POST /tools`（注册，admin）、`PATCH /tools/:id`（仅 schema/initCommand/enabled，admin）。**无 DELETE**（停用替代）。内置工具 6 个由 seed 写入（source=builtin），仅能停用不可删除。

### 3.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-TOL-001 | 工具列表：管理员全量查看（内置 + 自定义 + MCP） | 正向 | P0 | admin accessToken；环境已 seed | 1. `GET /api/v1/tools?page=1&pageSize=20` | 1. 返回 `200 OK`，结构 `{items, total, page, pageSize}`<br>2. `items` 含 6 个内置工具（action=bash/read/edit/write/grep/glob，`source=builtin`、`execution=code`、`enabled=true`，id 形如 `tl_builtin_bash`）<br>3. 每条含来源字段 `source`（builtin/custom/mcp），供页面渲染来源徽章（FR-48） |
| TC-TOL-002 | 工具列表：source 过滤断言内置工具形态 | 正向 | P1 | admin accessToken | 1. `GET /api/v1/tools?source=builtin`<br>2. `GET /api/v1/tools?source=custom`<br>3. `GET /api/v1/tools?source=mcp` | 1. `source=builtin` 返回 6 个内置工具（全部 `execution=code`、`enabled=true`）<br>2. `source=custom` 仅返回自定义注册工具（execution=code/cli/http）<br>3. `source=mcp` 仅返回 execution=mcp 的工具 |
| TC-TOL-003 | 注册 CLI 自定义工具（source 推导为 custom） | 正向 | P0 | admin accessToken；`cli-demo-<ts>` action 可用 | 1. `POST /api/v1/tools`，body：`{"name":"CLI 演示工具","action":"cli-demo-<ts>","execution":"cli","initCommand":[{"script":"echo ready"}],"schema":{"type":"object","properties":{"args":{"type":"string"}}}}` | 1. 返回 `201 Created`，响应工具对象：`{id: "tl_<数字>", name, action, source: "custom", execution: "cli", initCommand, schema, enabled: true}`<br>2. `source` 由 service 推导为 `custom`（非 mcp），注册成功即进入权限命名空间（action 即权限点，FR-48） |
| TC-TOL-004 | 注册 MCP 工具（source 推导为 mcp） | 正向 | P1 | admin accessToken；`mcp-demo-<ts>` action 可用 | 1. `POST /api/v1/tools`，body：`{"name":"MCP 工具","action":"mcp-demo-<ts>","execution":"mcp","mcpServer":"gitee-ent"}` | 1. 返回 `201 Created`，响应 `source: "mcp"`、`mcpServer: "gitee-ent"`<br>2. 权限点形如 `<server>_<tool>`（11 篇 §5.2），进入权限命名空间 |
| TC-TOL-005 | 停用工具（enabled=false 替代删除） | 正向 | P0 | admin accessToken；存在自定义工具 `tl_<id>` | 1. `PATCH /api/v1/tools/tl_<id>`，body：`{"enabled":false}` | 1. 返回 `200 OK`，响应工具对象 `enabled=false`<br>2. 成员侧 `GET /tools`（强制 enabled=true）不再可见该工具；工具仍在库中可再次启用 |
| TC-TOL-006 | 更新工具输入输出 schema | 正向 | P1 | admin accessToken；存在自定义工具 `tl_<id>` | 1. `PATCH /api/v1/tools/tl_<id>`，body：`{"schema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}` | 1. 返回 `200 OK`，响应 `schema` 为更新后的 JSON Schema<br>2. 其余字段（name/action/execution/source）保持不变 |

### 3.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-TOL-007 | 注册工具：缺少 name 必填字段 | 反向 | P0 | admin accessToken | 1. `POST /api/v1/tools`，body：`{"action":"t-no-name","execution":"code"}`（缺 name） | 1. 返回 `400 Bad Request`（`@IsString` 必填校验失败，message 数组列出缺 name）<br>2. 不创建工具 |
| TC-TOL-008 | 注册工具：execution 枚举非法 | 反向 | P0 | admin accessToken | 1. `POST /api/v1/tools`，body：`{"name":"x","action":"t-bad-exec","execution":"docker"}` | 1. 返回 `400 Bad Request`（`@IsIn(['code','cli','http','mcp'])` 校验失败） |
| TC-TOL-009 | 注册工具：action 格式非法（含大写） | 反向 | P1 | admin accessToken | 1. `POST /api/v1/tools`，body：`{"name":"x","action":"Bad_Action","execution":"code"}` | 1. 返回 `400 Bad Request`（action 不匹配 `^[a-z0-9][a-z0-9-_.]*$`） |
| TC-TOL-010 | 注册工具：action 与内置工具重复 | 反向 | P0 | admin accessToken；环境已 seed 内置工具 | 1. `POST /api/v1/tools`，body：`{"name":"x","action":"bash","execution":"code"}` | 1. 返回 `409 Conflict`，`code=TOOL_ACTION_EXISTS`，message「工具 action 已存在：bash」<br>2. 内置工具未被覆盖（工具名即权限点不可静默覆盖，11 篇 §9 边界） |
| TC-TOL-011 | 更新工具：工具不存在 | 反向 | P1 | admin accessToken | 1. `PATCH /api/v1/tools/tl_9999999999`，body：`{"enabled":false}` | 1. 返回 `404 Not Found`，`code=TOOL_NOT_FOUND`，message「工具 tl_9999999999 不存在」 |
| TC-TOL-012 | 更新工具：携带 name/action 等不可改字段被剥离 | 反向 | P1 | admin accessToken；存在工具 `tl_<id>` | 1. `PATCH /api/v1/tools/tl_<id>`，body：`{"name":"改名","action":"new-act","enabled":false}` | 1. 返回 `200 OK`（whitelist 剥离未知字段，不报错）<br>2. 实测响应 `name`/`action` **不变**，仅 `enabled=false` 生效——工具名即权限点注册后不可改（FR-48），文档标注此行为 |
| TC-TOL-013 | 内置工具只读断言：不可删除 | 反向 | P1 | admin accessToken | 1. `DELETE /api/v1/tools/tl_builtin_bash`<br>2.（对照）`PATCH /api/v1/tools/tl_builtin_bash`，body：`{"enabled":false}` | 1. 步骤 1 返回 `404 Not Found`（工具端点无 DELETE 路由，物理删除不存在）<br>2. 步骤 2 返回 `200 OK` 且 `enabled=false`——内置工具仅可停用，删除由停用替代（FR-35） |
| TC-TOL-014 | 工具列表：source/execution 过滤参数非法 | 反向 | P1 | admin accessToken | 1. `GET /api/v1/tools?source=invalid`<br>2.（变体）`GET /api/v1/tools?execution=invalid` | 1. 均返回 `400 Bad Request`（`@IsIn` 枚举校验失败） |
| TC-TOL-015 | 成员越权与未认证（写端点） | 反向 | P0 | seed-member token | 1. `POST /api/v1/tools` 用 seed-member token<br>2. `PATCH /api/v1/tools/tl_<id>` 用 seed-member token<br>3. `POST /api/v1/tools` 不带 Authorization 头 | 1. 步骤 1/2 返回 `403 Forbidden`，`code=FORBIDDEN_ADMIN`，message「需要 users:manage 管理员权限」（AdminGuard）<br>2. 步骤 3 返回 `401 Unauthorized`，`code=AUTH_UNAUTHORIZED` |
| TC-TOL-016 | 技能与工具页：注册工具入口与来源徽章（Web） | 正向 | P1 | 浏览器以 admin 登录进入技能与工具页 | 1. 切到「工具」页签<br>2. 点击「注册工具」打开 tool-register 表单，选择执行方式（代码/CLI/HTTP/MCP）并填写工具名/描述提交<br>3. 查看工具列表 | 1. 工具页展示全部工具，每行含工具名（action）、来源徽章（内置/自定义/MCP）与启用状态（§2.12）<br>2. 注册成功后新工具出现在列表，来源徽章按 `source` 渲染<br>3. 新工具可在 Agent 配置页逐工具配置 effect（FR-35/48 联动） |

---

## 4. MCP 服务器管理用例（TC-MCP）

> MCP 服务器端点：`GET /mcp-servers`（type/enabled 过滤 + name 搜索 + 分页，返回含 status 三态）、`GET /mcp-servers/:id`（详情）、`POST /mcp-servers`（创建，admin）、`PATCH /mcp-servers/:id`（部分更新，admin）、`DELETE /mcp-servers/:id`（物理删除，admin）。类型枚举 `local`（子进程，必填非空 command[]）/ `remote`（HTTP，必填合法 http(s) url）。`status` 字段为 worker 心跳上报的可用性三态（connected/failed/needs_auth），未上报时为 null。

### 4.1 正向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-MCP-001 | MCP 服务器列表 + status 字段 | 正向 | P0 | admin accessToken；已创建至少 1 台服务器 | 1. `GET /api/v1/mcp-servers?page=1&pageSize=20` | 1. 返回 `200 OK`，结构 `{items, total, page, pageSize}`<br>2. 每条含 `{id, name, type, command, url, headers, oauth, enabled, status}`；`status` 为 `connected`/`failed`/`needs_auth` 三态之一或 `null`（worker 未上报） |
| TC-MCP-002 | MCP 服务器详情 | 正向 | P1 | admin accessToken；存在服务器 `ms_<id>` | 1. `GET /api/v1/mcp-servers/ms_<id>` | 1. 返回 `200 OK`，响应同列表单条结构，含 `status` 字段 |
| TC-MCP-003 | 创建 local 类型服务器（stdio 子进程） | 正向 | P0 | admin accessToken；`tc-local-<ts>` name 可用 | 1. `POST /api/v1/mcp-servers`，body：`{"name":"tc-local-<ts>","type":"local","command":{"command":["npx","-y","@modelcontextprotocol/server-filesystem"],"cwd":"/tmp","timeout":30}}` | 1. 返回 `201 Created`，响应服务器对象：`{id: "ms_<数字>", name, type: "local", command, url: null, enabled: true}`<br>2. `enabled` 默认 true；创建成功向在线 worker 广播 reload-config |
| TC-MCP-004 | 创建 remote 类型服务器（HTTP 服务） | 正向 | P0 | admin accessToken；`tc-remote-<ts>` name 可用 | 1. `POST /api/v1/mcp-servers`，body：`{"name":"tc-remote-<ts>","type":"remote","url":"https://example.com/mcp","headers":{"Authorization":"Bearer {env:API_KEY}"}}` | 1. 返回 `201 Created`，响应 `type: "remote"`、`url` 原样保存、`headers` 保存<br>2. 支持 `oauth` 对象或 `false`（显式禁用自动 OAuth） |
| TC-MCP-005 | 停用 MCP 服务器（enabled=false） | 正向 | P1 | admin accessToken；存在服务器 `ms_<id>` | 1. `PATCH /api/v1/mcp-servers/ms_<id>`，body：`{"enabled":false}` | 1. 返回 `200 OK`，响应 `enabled=false`<br>2. 其余字段不变；列表可再次启用 |
| TC-MCP-006 | 删除 MCP 服务器（物理删除闭环） | 正向 | P0 | admin accessToken；存在服务器 `ms_<id>` | 1. `DELETE /api/v1/mcp-servers/ms_<id>`<br>2. `GET /api/v1/mcp-servers/ms_<id>` | 1. 步骤 1 返回 `200 OK`（物理删除）<br>2. 步骤 2 返回 `404 Not Found`，`code=MCP_SERVER_NOT_FOUND`（已不存在） |

### 4.2 反向用例

| 用例编号 | 用例名称 | 用例类型 | 优先级 | 前置条件 | 操作步骤 | 预期结果 |
|---------|---------|---------|-------|---------|---------|---------|
| TC-MCP-007 | 创建服务器：name 格式非法 | 反向 | P1 | admin accessToken | 1. `POST /api/v1/mcp-servers`，body：`{"name":"Bad Name","type":"remote","url":"https://example.com"}`（含空格/大写） | 1. 返回 `400 Bad Request`（name 不匹配 `^[a-z0-9][a-z0-9-_.]*$`，message「name 需为小写字母/数字/连字符/下划线/点开头」） |
| TC-MCP-008 | 创建 local 服务器：缺 command / command 为空 | 反向 | P0 | admin accessToken | 1. `POST /api/v1/mcp-servers`，body：`{"name":"tc-bad-local-<ts>","type":"local"}`<br>2.（变体）`{"name":"tc-bad-local2-<ts>","type":"local","command":{"command":[]}}`<br>3.（变体）command 数组含空串 | 1. 均返回 `400 Bad Request`，`code=MCP_SERVER_INVALID_CONFIG`，message「local 类型服务器必须提供非空 command[]」<br>2. 不创建服务器 |
| TC-MCP-009 | 创建 remote 服务器：缺 url / url 非 http(s) | 反向 | P0 | admin accessToken | 1. `POST /api/v1/mcp-servers`，body：`{"name":"tc-bad-remote-<ts>","type":"remote"}`<br>2.（变体）url 传 `"ftp://example.com"` 或 `"example.com"` | 1. 均返回 `400 Bad Request`（`MCP_SERVER_INVALID_CONFIG`：remote 缺 url；DTO `@Matches(/^https?:\/\/.+/)` 拦截非 http(s)）<br>2. 不创建服务器 |
| TC-MCP-010 | 创建服务器：name 与既有服务器重复 | 反向 | P0 | admin accessToken；已存在 `tc-local-<ts>` | 1. `POST /api/v1/mcp-servers`，body：`{"name":"tc-local-<ts>","type":"local","command":{"command":["echo","hi"]}}` | 1. 返回 `409 Conflict`，`code=MCP_SERVER_NAME_EXISTS`，message「MCP 服务器名称已存在：tc-local-<ts>」<br>2. 不重复创建 |
| TC-MCP-011 | 更新服务器：合并后配置非法（local 改 remote 但无 url） | 反向 | P1 | admin accessToken；存在 local 服务器 `ms_<id>` | 1. `PATCH /api/v1/mcp-servers/ms_<id>`，body：`{"type":"remote"}`（未带 url）<br>2.（对照）body：`{"type":"remote","url":"https://example.com/mcp"}` | 1. 步骤 1 返回 `400 Bad Request`，`code=MCP_SERVER_INVALID_CONFIG`（按合并后的最终配置校验：remote 缺 url）<br>2. 步骤 2 返回 `200 OK`，`type=remote`、`url` 生效 |
| TC-MCP-012 | 更新/删除：服务器不存在 | 反向 | P1 | admin accessToken | 1. `PATCH /api/v1/mcp-servers/ms_9999999999`，body：`{"enabled":false}`<br>2. `DELETE /api/v1/mcp-servers/ms_9999999999`<br>3. `GET /api/v1/mcp-servers/ms_9999999999` | 1. 三种请求均返回 `404 Not Found`，`code=MCP_SERVER_NOT_FOUND` |
| TC-MCP-013 | 未认证访问管理端点 | 反向 | P0 | 无 token | 1. `POST /api/v1/mcp-servers` 不带 Authorization 头 | 1. 返回 `401 Unauthorized`，`code=AUTH_UNAUTHORIZED` |
| TC-MCP-014 | 成员越权（写端点）与只读可见 | 反向 | P0 | seed-member token | 1. `POST /api/v1/mcp-servers` 用 seed-member token（合法 body）<br>2. `DELETE /api/v1/mcp-servers/ms_<id>` 用 seed-member token<br>3. `GET /api/v1/mcp-servers` 用 seed-member token | 1. 步骤 1/2 返回 `403 Forbidden`，`code=FORBIDDEN_ADMIN`<br>2. 步骤 3 返回 `200 OK`（成员只读可见全部服务器列表，含启用与停用） |

---

## 5. 覆盖矩阵与执行提示

**端点覆盖清单**

| 模块 | 端点 | 正向 | 反向 |
|------|------|------|------|
| Skills | `GET /skills` | TC-SKL-002/003/004 | TC-SKL-019/020 |
| Skills | `GET /skills/:id/content` | TC-SKL-005 | — |
| Skills | `POST /skills` | TC-SKL-001 | TC-SKL-010/011/012/013/014/020 |
| Skills | `PATCH /skills/:id` | TC-SKL-008/009 | TC-SKL-017/018 |
| Skills | `PATCH /skills/:id/status` | TC-SKL-006/007 | TC-SKL-015/016 |
| Tools | `GET /tools` | TC-TOL-001/002 | TC-TOL-014 |
| Tools | `POST /tools` | TC-TOL-003/004 | TC-TOL-007/008/009/010/015 |
| Tools | `PATCH /tools/:id` | TC-TOL-005/006 | TC-TOL-011/012/013 |
| McpServers | `GET /mcp-servers` | TC-MCP-001 | TC-MCP-014 |
| McpServers | `GET /mcp-servers/:id` | TC-MCP-002 | TC-MCP-012 |
| McpServers | `POST /mcp-servers` | TC-MCP-003/004 | TC-MCP-007/008/009/010/013/014 |
| McpServers | `PATCH /mcp-servers/:id` | TC-MCP-005 | TC-MCP-011/012 |
| McpServers | `DELETE /mcp-servers/:id` | TC-MCP-006 | TC-MCP-012/014 |

**执行提示**

- 技能上传用例会真实写入 DB（skills 表无 DELETE 端点），执行后建议用 `PATCH /skills/:id/status {"enabled":false}` 停用清理（不会影响成员侧列表）。
- 工具注册用例同理无 DELETE，执行后用 `PATCH /tools/:id {"enabled":false}` 停用清理；内置工具（bash/read/edit/write/grep/glob）与既有数据**禁止停用或修改**。
- MCP 服务器用例带物理 DELETE，执行后可直接删除测试服务器，不影响既有数据。
- 技能/工具/MCP 变更落库后会向在线 worker 广播 `reload-config`；如无在线 worker，日志出现「广播 reload-config 失败」告警属正常，不影响用例断言。
