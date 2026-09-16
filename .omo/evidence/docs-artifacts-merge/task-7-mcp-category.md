# T7 证据 — submit_artifact + doclib 透出 category

## 变更文件
- `server/src/platform-mcp/platform-mcp.tools.ts`：import `ARTIFACT_CATEGORIES`（constants 纯常量、无循环）；
  `submitArtifactSchema` 加 `category: z.enum(ARTIFACT_CATEGORIES).optional()`，描述
  `分类标签（可选）：需求/设计/实现/测试用例/测试报告/运维/其他其一；不传为未分类`。
- `server/src/platform-mcp/platform-mcp.service.ts`：
  - `submitArtifact` args 加 `category?: string`；非法值 → 400 `PLATFORM_MCP_ARTIFACT_INVALID`
   （与 text 缺 content / doc 缺 fileRef 同码）；
  - text 路径：`append(taskId, {..., ...(category !== undefined ? {category} : {})})`
   （缺省不传键，旧调用字节一致）；
  - doc/file 路径：`submitFileArtifact(ctx, taskId, title, fileRef, category)` →
    `archiveFile(taskId, {...}, category)` 第三参数（T4 形状）；
  - `doclib` 清单 `select` + 映射加 `category`（`?? null`），详情 `select` + 顶层加 `category`。
- `server/src/platform-mcp/platform-mcp.service.spec.ts`：doclib 清单/详情 category 用例
  （含 `null` 后向兼容）；submit_artifact 新增 4 用例（text 带 category 透传 / text 不带键回归 /
  非法 400 不触达 append / doc-file 第三参数透传）；旧 `archiveFile` 断言补第三参数 `undefined`。
- `server/src/platform-mcp/platform-mcp.controller.spec.ts`：工具数保持 26（仅 schema 变）；
  submit_artifact 加 `properties.category == {type:'string'}` 断言；新增 tools/call 带 category 透传用例。
- `server/prisma/seed.ts`（prototype-designer skill 文本，纯文本改动零逻辑）：
  数据链路由 `DocsMirrorService.syncTask → docs-root` 改为 Artifact 表 + DB 直读；
  `buildRegistry只收录.md` 改为文档库 DB 直读；关联表 `DocsMirrorService` 行改为
  `ArtifactsService（DB 直读 listPrototypes/readPrototype）`。
- `seed.spec.ts` 无需改：不断言该 skill 文本（`src/prisma/seed.spec.ts` 全绿确认）。

## 验证命令 + 结果
- `npx tsc --noEmit -p tsconfig.json`（server）：零输出，退出 0。
- `npm test --prefix server -- --runInBand src/platform-mcp`（前台）：
  8 suites / 326 tests 全绿（含 `plan-removal.guard.spec.ts` 三态金丝雀）。
- `npm test --prefix server -- --runInBand src/prisma/seed.spec.ts src/artifacts`：
  4 suites / 120 tests 全绿。
- 一致性门：`grep 需求/设计/实现 server/src` 仅 4 处（tools 描述 / service 400 文案 /
  artifacts.service 校验文案 / artifact.dto 描述），词表一致，无第二处 zod category 定义。

## QA 双路径（mock 层断言，对应 T12 live 复验）
- happy：`submitArtifact({type:'text', title:'登录用例', content:'用例正文', category:'测试用例'})`
  → `append` 收到 `category:'测试用例'`，返回 `{artifactId:'a_2', version:1, status:'created'}`；
  `submitArtifact({type:'file', ..., category:'设计'})` → `archiveFile(taskId, {...}, '设计')`。
- failure-inverse（后向兼容）：不带 category 的 text 调用 → `append` 实参无 `category` 键；
  doc 调用 → `archiveFile` 第三参数 `undefined`；doclib 缺 category 行透出 `null`。
- failure：`category:'不存在的类'` → 400 `PLATFORM_MCP_ARTIFACT_INVALID`，`append` 零调用。
- T12 复验载荷：`{taskId, selfInstanceId, type:'text', title, content, category:'测试用例'}`
  落库后 `doclib({taskId, artifactId})` 应返回同值 `category`。
