---
title: 技能工具与MCP管理测试报告
id: test-report-skills-tools-mcp
order: 5
kind: 测试报告
---

# 技能工具与MCP管理测试报告

## 一、执行摘要

- **测试对象**：技能管理（Skills）、工具管理（Tools）、MCP 服务器管理（McpServers）
- **环境**：API `http://192.168.10.78:13000/api/v1`，Web `http://192.168.10.78:13001`
- **执行时间**：2026-08-10（UTC 14:57 ~ 15:03）
- **认证**：admin/admin123（管理员）、seed-member/Admin@123456（只读成员）
- **时间戳隔离**：`ts=1786373866` 追加到全部测试资源 name/action

### 结果统计

| 指标 | 数量 |
|------|------|
| 用例总数 | 51 |
| PASS | 49 |
| FAIL | 0 |
| BLOCKED | 2（均为 Web 交互类，页面可达性已验证） |
| 通过率（API 用例） | 49/49 = **100%** |
| 通过率（全部用例） | 49/51 = **96.1%** |

### 按优先级分组

| 优先级 | 总数 | PASS | FAIL | BLOCKED |
|--------|------|------|------|---------|
| P0 | 28 | 27 | 0 | 1（TC-SKL-021 Web 交互） |
| P1 | 23 | 22 | 0 | 1（TC-TOL-016 Web 交互） |

**结论**：所有 API 用例（49 条）真实执行全部通过，错误码与文档预期完全一致（SKILL_FILE_REQUIRED / SKILL_FRONTMATTER_INVALID / SKILL_NAME_EXISTS / TOOL_ACTION_EXISTS / MCP_SERVER_INVALID_CONFIG / MCP_SERVER_NAME_EXISTS / FORBIDDEN_ADMIN / FORBIDDEN_PERMISSION / AUTH_UNAUTHORIZED 等）。实现与文档「实现与需求差异说明」吻合（含 POST /tools 必填 action、PATCH /tools/:id 字段剥离、技能/工具无 DELETE 等）。无 FAIL 用例，未发现缺陷。

## 二、用例执行明细

### TC-SKL 技能管理（21 条）

| 用例编号 | 名称 | 类型 | 优先级 | 结果 | 实际结果 |
|---------|------|------|--------|------|---------|
| TC-SKL-001 | 上传合法 SKILL.md 注册技能（默认停用） | 正向 | P0 | PASS | 201，id=sk_0000000002，name=tc-skill-1786373866，enabled=false，fileMeta 含 version=1.0.0/allowedTools=[bash,read]，content 原文落库 |
| TC-SKL-002 | 技能列表：管理员全量查看 + 分页 | 正向 | P0 | PASS | 200，{items, total:2, page, pageSize}，含停用技能，按 createdAt 升序 |
| TC-SKL-003 | 技能列表：enabled=true 只返回启用技能 | 正向 | P1 | PASS | 200；执行时无启用技能 total=0（过滤生效），TC-SKL-006 启用后复核 total=1 且仅含该技能 |
| TC-SKL-004 | 技能列表：name 模糊搜索 | 正向 | P1 | PASS | 200，name=tc-skill 命中 1 条（tc-skill-1786373866） |
| TC-SKL-005 | 拉取技能 SKILL.md 全文 | 正向 | P0 | PASS | 200，{id, name, content}，content 与上传原文逐字一致（含 --- frontmatter） |
| TC-SKL-006 | 启用技能（PATCH status enabled=true） | 正向 | P0 | PASS | 200，enabled=true；GET /skills?enabled=true 可见 |
| TC-SKL-007 | 停用技能（enabled=false 替代删除） | 正向 | P0 | PASS | 200，enabled=false；成员侧 GET /skills 强制 enabled=true，total=0 不可见 |
| TC-SKL-008 | 编辑技能描述并同步重写 frontmatter | 正向 | P1 | PASS | 200，description=新描述；content frontmatter 同步重写为「新描述」 |
| TC-SKL-009 | 编辑技能全文内容并反向同步列 | 正向 | P1 | PASS | 200，name 反向解析为 tc-skill-renamed-1786373866，description=内容变更，列表一致 |
| TC-SKL-010 | 上传技能：请求未携带 file 字段 | 反向 | P0 | PASS | 400，code=SKILL_FILE_REQUIRED，「缺少 file 文件（SKILL.md 技能包）」 |
| TC-SKL-011 | 上传技能：文件非 --- 开头 | 反向 | P0 | PASS | 400，code=SKILL_FRONTMATTER_INVALID，「文件必须以 --- 开头的 YAML frontmatter」 |
| TC-SKL-012 | 上传技能：frontmatter 块未闭合 | 反向 | P1 | PASS | 400，code=SKILL_FRONTMATTER_INVALID，「未找到 frontmatter 结束标记 ---」 |
| TC-SKL-013 | 上传技能：缺 name / name 非法格式 | 反向 | P0 | PASS | 400×2，SKILL_FRONTMATTER_INVALID：缺 name 报「缺少必填字段 name」；Bad-Name 报「不符合命名规范（小写字母数字，中划线分段）」 |
| TC-SKL-014 | 上传技能：name 与既有技能重复 | 反向 | P0 | PASS | 409，code=SKILL_NAME_EXISTS，「技能名称「tc-skill-renamed-1786373866」已存在」 |
| TC-SKL-015 | 启停技能：enabled 非法布尔 / 缺字段 | 反向 | P1 | PASS | 400×2（"enabled must be a boolean value"）；技能状态保持不变（enabled=false） |
| TC-SKL-016 | 启停技能：技能不存在 | 反向 | P1 | PASS | 404，code=SKILL_NOT_FOUND，「技能 sk_9999999999 不存在」 |
| TC-SKL-017 | 编辑技能：请求体为空 | 反向 | P1 | PASS | 400，code=SKILL_UPDATE_EMPTY，「无可更新字段（name/description/content 至少提供一个）」 |
| TC-SKL-018 | 编辑技能：技能不存在 | 反向 | P1 | PASS | 404，code=SKILL_NOT_FOUND |
| TC-SKL-019 | 技能列表：enabled 过滤参数非法 | 反向 | P1 | PASS | 400（"enabled must be a boolean value"） |
| TC-SKL-020 | 成员只读与越权、未认证 | 反向 | P0 | PASS | ①成员 GET 200 强制 enabled=true（total=0）②成员 POST 403 FORBIDDEN_PERMISSION「缺少 skills.create 权限」③无 token 401 AUTH_UNAUTHORIZED |
| TC-SKL-021 | 技能与工具页：技能上传与启停交互（Web） | 正向 | P0 | BLOCKED | 页面可达性 PASS：/skills 返回 200，Next.js 页面 chunk（skills/page-*.js）正常加载，Web 代理 /api/v1/skills 可达（无 token 401 属正常）。上传与开关交互需人工浏览器验证 |

### TC-TOL 工具管理（16 条）

| 用例编号 | 名称 | 类型 | 优先级 | 结果 | 实际结果 |
|---------|------|------|--------|------|---------|
| TC-TOL-001 | 工具列表：管理员全量查看 | 正向 | P0 | PASS | 200，total=7：6 个内置（bash/read/edit/write/grep/glob，source=builtin、execution=code、enabled=true、id=tl_builtin_*）+ 1 个既有 mcp 工具，均含 source 字段 |
| TC-TOL-002 | 工具列表：source 过滤断言 | 正向 | P1 | PASS | builtin=6（全 code/enabled=true）；custom 过滤生效（当时 0 条，TC-TOL-003 创建后归属 custom）；mcp=1（mcp-xtest） |
| TC-TOL-003 | 注册 CLI 自定义工具（source 推导 custom） | 正向 | P0 | PASS | 201，id=tl_0000000002，source=custom、execution=cli、initCommand/schema 保存、enabled=true |
| TC-TOL-004 | 注册 MCP 工具（source 推导 mcp） | 正向 | P1 | PASS | 201，id=tl_0000000003，source=mcp、mcpServer=gitee-ent |
| TC-TOL-005 | 停用工具（enabled=false 替代删除） | 正向 | P0 | PASS | 200，enabled=false；成员侧 GET /tools 不再可见该工具 |
| TC-TOL-006 | 更新工具输入输出 schema | 正向 | P1 | PASS | 200，schema 更新为含 required:[path] 的新 JSON Schema，name/action/execution/source 不变 |
| TC-TOL-007 | 注册工具：缺少 name 必填字段 | 反向 | P0 | PASS | 400（name 必填校验失败） |
| TC-TOL-008 | 注册工具：execution 枚举非法 | 反向 | P0 | PASS | 400（"execution must be one of: code, cli, http, mcp"） |
| TC-TOL-009 | 注册工具：action 格式非法（含大写） | 反向 | P1 | PASS | 400（action 规则 ^[a-z0-9][a-z0-9-_.]*$） |
| TC-TOL-010 | 注册工具：action 与内置工具重复 | 反向 | P0 | PASS | 409，code=TOOL_ACTION_EXISTS，「工具 action 已存在：bash」；内置工具未被覆盖 |
| TC-TOL-011 | 更新工具：工具不存在 | 反向 | P1 | PASS | 404，code=TOOL_NOT_FOUND，「工具 tl_9999999999 不存在」 |
| TC-TOL-012 | 更新工具：携带 name/action 被剥离 | 反向 | P1 | PASS | 200（whitelist 剥离不报错），name/action 不变，仅 enabled 生效（在启用中的 tl_0000000003 上验证） |
| TC-TOL-013 | 内置工具只读断言：不可删除 | 反向 | P1 | PASS | ①DELETE /tools/tl_builtin_bash → 404（无 DELETE 路由）②对照 PATCH 返回 200（以 enabled=true 幂等请求验证端点可用，未实际切换停用以免违反「禁止停用内置工具」约束） |
| TC-TOL-014 | 工具列表：source/execution 过滤参数非法 | 反向 | P1 | PASS | 400×2（枚举校验：builtin/custom/mcp 与 code/cli/http/mcp） |
| TC-TOL-015 | 成员越权与未认证（写端点） | 反向 | P0 | PASS | ①/② 403 FORBIDDEN_ADMIN「需要 users:manage 管理员权限」③无 token 401 AUTH_UNAUTHORIZED |
| TC-TOL-016 | 技能与工具页：注册工具入口与来源徽章（Web） | 正向 | P1 | BLOCKED | 页面可达性 PASS：/skills 返回 200，页面 chunk 正常加载。注册表单填写、来源徽章渲染等交互需人工浏览器验证 |

### TC-MCP MCP 服务器管理（14 条）

| 用例编号 | 名称 | 类型 | 优先级 | 结果 | 实际结果 |
|---------|------|------|--------|------|---------|
| TC-MCP-001 | MCP 服务器列表 + status 字段 | 正向 | P0 | PASS | 200，{items, total:2, page, pageSize}，每条含 {id, name, type, command, url, headers, oauth, enabled, status}，status=failed（占位配置 worker 探测失败，属三态之一） |
| TC-MCP-002 | MCP 服务器详情 | 正向 | P1 | PASS | 200，响应含全部字段 + status=failed |
| TC-MCP-003 | 创建 local 类型服务器（stdio 子进程） | 正向 | P0 | PASS | 201，id=ms_0000000002，type=local，command{cwd,command[],timeout} 保存，url=null，enabled=true |
| TC-MCP-004 | 创建 remote 类型服务器（HTTP 服务） | 正向 | P0 | PASS | 201，id=ms_0000000003，type=remote，url 原样保存，headers 保存 |
| TC-MCP-005 | 停用 MCP 服务器（enabled=false） | 正向 | P1 | PASS | 200，enabled=false，其余字段不变 |
| TC-MCP-006 | 删除 MCP 服务器（物理删除闭环） | 正向 | P0 | PASS | DELETE → 200（空 body）；复核 GET → 404 MCP_SERVER_NOT_FOUND |
| TC-MCP-007 | 创建服务器：name 格式非法 | 反向 | P1 | PASS | 400（name 规则 ^[a-z0-9][a-z0-9-_.]*$，「name 需为小写字母/数字/连字符/下划线/点开头」） |
| TC-MCP-008 | 创建 local：缺 command / 空数组 / 含空串 | 反向 | P0 | PASS | 400×3，code=MCP_SERVER_INVALID_CONFIG，「local 类型服务器必须提供非空 command[]」 |
| TC-MCP-009 | 创建 remote：缺 url / 非 http(s) | 反向 | P0 | PASS | 缺 url → 400 MCP_SERVER_INVALID_CONFIG；ftp:// 与 example.com → 400（"url 需为合法 http(s) 地址"） |
| TC-MCP-010 | 创建服务器：name 重复 | 反向 | P0 | PASS | 409，code=MCP_SERVER_NAME_EXISTS，「MCP 服务器名称已存在：tc-remote-1786373866」 |
| TC-MCP-011 | 更新服务器：合并后配置非法（local→remote 无 url） | 反向 | P1 | PASS | ①{type:remote} 无 url → 400 MCP_SERVER_INVALID_CONFIG（按合并后最终配置校验）②{type:remote,url} → 200，type=remote、url 生效 |
| TC-MCP-012 | 更新/删除：服务器不存在 | 反向 | P1 | PASS | PATCH/DELETE/GET 均 404，code=MCP_SERVER_NOT_FOUND |
| TC-MCP-013 | 未认证访问管理端点 | 反向 | P0 | PASS | 401，code=AUTH_UNAUTHORIZED |
| TC-MCP-014 | 成员越权（写端点）与只读可见 | 反向 | P0 | PASS | ①/② 403 FORBIDDEN_ADMIN ③成员 GET 200 可见全部服务器列表（含启用与停用） |

## 三、失败用例分析

**FAIL 用例：0 条，无缺陷。**

## 四、阻塞/未执行说明

| 用例编号 | 阻塞原因 | 已验证部分 |
|---------|---------|-----------|
| TC-SKL-021 | Web 交互类（文件上传、启停开关），需人工浏览器验证 | 页面可达性已通过 curl 验证：/skills 返回 200，Next.js 页面 chunk 正常加载，Web 代理 API 可达 |
| TC-TOL-016 | Web 交互类（注册工具表单、来源徽章渲染），需人工浏览器验证 | 同上 |

**说明**：
1. TC-TOL-013 步骤 2（PATCH 内置工具 enabled=false）未实际切换停用，改用 enabled=true 幂等请求验证 PATCH 端点对内置工具可用（返回 200、结构完整），避免违反「内置工具禁止停用或修改」约束；DELETE 404 已真实验证。
2. MCP 服务器 status 均为 `failed`：占位配置（不连接真实外部服务）下 worker 健康探测失败属预期，三态枚举（connected/failed/needs_auth/null）字段存在性已验证。
3. 技能/工具无 DELETE 端点，测试资源通过 enabled=false 停用清理（sk_0000000002、tl_0000000002、tl_0000000003）；MCP 测试服务器已物理删除（ms_0000000002/3/4），清理后 mcp-servers total=0。内置工具 6 个全程未受影响（enabled=true）。
4. 变更落库后 worker 无在线实例，日志可能出现「广播 reload-config 失败」告警，属文档所述正常现象，不影响断言。

## 五、回归建议

- 技能/工具「无 DELETE、停用替代」的设计已在全部相关用例中验证，后续需求若引入物理删除需重新评估权限模型。
- POST /tools 的 action 必填字段与 PATCH /tools/:id 的字段剥离行为与 `09-API设计.md` 原始设计存在差异，文档已标注，建议同步更新接口文档。
- `execution=mcp` 不带 mcpServer 仍可创建（文档差异说明第 2 条），保持待改进项跟踪。
