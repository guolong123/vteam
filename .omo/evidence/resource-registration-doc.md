# 证据：资源与注册机制独立成篇（11 篇）

日期：2026-08-06
变更：新建 `docs/agent-platform/11-资源与注册机制（工具skills-mcp）.md`（397 行）——三类资源（工具/Skills/MCP）与 opencode 注册机制的专章，以官方文档 + 07 篇已核实源码事实为事实依据，落地平台 Worker 的资源装配方式。不改 01-10 篇。

## 文件变更

| 文件 | 变更 |
|------|------|
| `docs/agent-platform/11-资源与注册机制（工具skills-mcp）.md`（新建，397 行） | frontmatter（title: 资源与注册机制（工具/Skills/MCP）, id: resource-registration-mechanism, order: 11, kind: 技术设计）；§1 定位与文档关系（07 篇讲权限规则/本文讲资源链路）；§2 资源全景表（三类资源 × 定义/注册/发现/暴露/权限 action + 工具名即权限 action 落点）；§3 工具注册机制（内置 Tool.define / 自定义两条路径 / v2 Tool.make+materialize / 平台映射）；§4 Skills（frontmatter / 官方 6 发现路径 / skill 工具 + available_skills / skill 权限 / 平台映射）；§5 MCP（local/remote 配置 / `<server>_<tool>` 命名 / 权限通配 / 资源 3 工具 / ToolListChanged / OAuth / v2 未实现 / 平台映射）；§6 注册→暴露→权限过滤 mermaid 时序图；§7 平台资源管理模型（生命周期表 / v1 vs v2 生效 / 资源×Agent 绑定）；§8 v1 vs v2 差异表；§9 边界与开放问题（v2 MCP 未实现等 5 项） |

## 官方机制事实依据（本次核实，均来自官方文档）

- Skills 官方 6 发现路径（.opencode/skills、~/.config/opencode/skills、.claude/skills ×2、.agents/skills ×2）；frontmatter name/description 均必填，name 正则 `^[a-z0-9]+(-[a-z0-9]+)*$` 且须与目录名一致；description 1-1024 字符。
- `<available_skills>` 注入 skill 工具描述（name+description），模型以 `skill({name})` 按名调用；permission.skill 支持 `internal-*` 通配，deny 时技能对模型隐藏；tools.skill=false 时 available_skills 整体省略。
- 自定义工具：`.opencode/tools/`（项目）+ `~/.config/opencode/tools/`（全局）；默认导出=文件名、具名导出=`<filename>_<export>`；`tool()` 工厂 + tool.schema（Zod）；同名覆盖内置工具，禁用内置用 permission 而非覆盖。
- Permissions：三态 allow/ask/deny、按工具名 keyed（工具名即权限 action）、通配 `*`/`?`、对象语法最后匹配生效、ask 三结果 once/always/reject、默认多数 allow（external_directory/doom_loop 默认 ask、read 默认 allow 但 .env deny）、agent 覆盖全局。
- MCP：opencode.json 顶层 `mcp` 节；local（type/command/cwd/environment/enabled/timeout，stdio StdioClientTransport）/ remote（type/url/headers/oauth/enabled/timeout，StreamableHTTP）；MCP 工具自动对 LLM 可用，工具名 = `<server>_<tool>`（官方原文 "registered with server name as prefix"，通配 `"mymcpservername_*": false`）；OAuth 自动（401→DCR RFC 7591，token 存 `~/.local/share/opencode/mcp-auth.json`，CLI `opencode mcp auth/list/logout/debug`）。
- MCP 资源 3 工具（list_mcp_resources / list_mcp_resource_templates / read_mcp_resource）为本环境实际存在的内置工具，权限 read + `mcp:<server>:*`。
- v2 MCP：配置 Schema 已定义（snake_case、servers 嵌套）但客户端与工具适配未实现（源码 TODO），唯一实现是 v1 → 平台 v1 完整支持 MCP、v2 迁移列为待验证项。

## 引用处理

- 04 篇引用采用实际编号：FR-27（技能上传/工具注册）、FR-34（技能配置）、FR-35（工具配置）、FR-48（逐工具权限）；工具权限落点写 FR-35/FR-48（任务描述中的「FR-40 工具权限」与 04 篇原文不符——FR-40 实为「结论文本直接归档」，未照抄）。
- 07 篇引用：§3.1（PermissionV2/权限链路三步）、§10.3（v1 写文件+重启四步流程）、§10.4（v2 transform 热更新）、§11.3/§11.5（控制协议/只动 worker 侧）。
- 08 篇引用：§3.1 SkillsToolsModule、§6.1 tools 表 action 列、§7.6 权限边界。
- 06 篇引用：§2.8 agent 配置原型、§2.9 技能与工具管理页。
- 09 篇引用：§3.12 SkillsTools 端点（不重复端点表）。

## 验证结果

| 检查 | 结果 |
|------|------|
| 行数 ≥300 | ✅ 397 行 |
| 含「工具名即权限 action」 | ✅ 4 处 |
| skill 6 发现路径（.opencode/skills 等） | ✅ |
| MCP `<server>_<tool>` | ✅ 7 处 |
| v2 MCP 未实现（客户端与工具适配尚未实现） | ✅ |
| mermaid ≥1 块（§6 sequenceDiagram） | ✅ 1 块 |
| `<available_skills>` | ✅ 8 处 |
| md-docs build 退出码 | ✅ 0（1.08s） |
| build 产物注入 resource-registration-mechanism key | ✅ 1 次（dist/assets） |
| dev 服务虚拟模块注入（virtual:md-docs-content）| ✅ resource-registration-mechanism 1 次、工具名即权限 1 次、available_skills 8 次 |
| 未改动 01-10 篇 | ✅ 仅新建 11 篇 |

---

## 更新（§5 远程协议选择，2026-08-06）

**需求**：平台 MCP 注册时远程方式需支持选择协议。

**改动**（仅 11 篇，397→418 行）：
- §5.1 配置表后新增「远程协议说明」段：opencode remote 自动探测（Streamable HTTP 优先 → SSE 回退，源码 `packages/opencode/src/mcp/index.ts:269-284`）；官方配置无协议选择字段。
- 新增 §5.2「远程协议选择（平台层设计）」：协议支持矩阵表（stdio/Streamable HTTP/HTTP + SSE，含 MCP 规范日期 2025-03-26 新版 / 2024-11-05 旧版）；平台注册表单协议字段枚举 `auto（默认）/ streamable-http / sse`；协议定位为平台元数据不透传进 opencode 配置，冲突以 opencode 实际探测为准并回显；worker 回传实际传输名（StreamableHTTP/SSE）展示「实际协议」，与 §5.9 平台映射三态衔接。
- 原 §5.2~§5.8 顺延为 §5.3~§5.9，本篇内 15 处交叉引用同步更新（含两处特殊形式：`动态刷新（§5.5）` 连锁误伤与 `，§5.7）` 前导逗号形式）。
- §8 差异表 MCP 配置行补充协议说明，标注 v2 迁移需验证双协议支持。

**验证**：md-docs build exit=0；grep 断言「Streamable HTTP」×4、「HTTP + SSE」×1、「auto」×2、「自动探测」×8、「2025-03-26」「2024-11-05」各 ×1；dist bundle 注入「远程协议选择（平台层设计）」×1、「Streamable HTTP」×4；§5.x 引用全部指向正确目标小节。

---

## 更新（§5 远程协议选择回退，2026-08-06）

**回退决策**：官方（opencode）配置不支持协议参数、remote 连接由 opencode 自动探测（Streamable HTTP 优先 → SSE 回退）——**平台层不提供协议选择字段**，撤销上一轮新增的 §5.2 远程协议选择设计。

**变更明细**（418→399 行）：
- **删除** §5.2「远程协议选择（平台层设计）」整节（19 行）：协议支持矩阵表、注册表单协议字段枚举（auto/streamable-http/sse）、协议字段定位/不透传/实际协议回显/worker 回传传输名/三态补充实际协议全部移除。
- **保留** §5.1 说明段的事实性内容：remote 自动探测（源码 `packages/opencode/src/mcp/index.ts:269-284`）；句尾改为「**平台不提供协议选择字段，连接协议由 opencode 自动探测**」。
- **编号恢复**：原 §5.3~§5.9 恢复为 §5.2~§5.8（工具暴露/权限通配/资源访问/动态刷新/OAuth/v2 现状/平台映射）。
- **引用恢复**：15 处引用回归原编号；§8 差异表 MCP 配置行去掉已删 §5.2 引用，改引 §5.1（自动探测事实），v2 迁移待验证引 §5.7。
- **连锁替换误伤修正**：恢复过程被 `（§5.7）→（§5.6）` 误伤的 3 处（v2 现状引用）已精确修复。

**验证**：md-docs build exit=0；`远程协议选择` 0 命中（已删除）、`streamable-http` 0 命中（已删除）、`自动探测` 2 命中（说明段+§8 行）；§5 标题 5.1~5.8 连续无跳号；引用分布与回退前基线一致（§5.7 ×5 全部指向 v2 现状）；dist bundle 注入 `远程协议选择` 0、「自动探测」3、「资源与注册机制」3。
