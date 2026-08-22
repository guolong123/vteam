# Plan: 记忆 description 分层按需注入（模型携带）

> **Type**: feature | **Slug**: `memory-layered-description-injection` | **Intent**: CLEAR | **Review**: false

## Goal
`description` 由模型在 `memory_save` 时携带，系统提示仅注索引（标签+描述列表），Agent 按索引按需 `memory_search` 多次小批量拉取正文，避免上下文过长；列表首屏展示 `description`，展开再取 `content`。

## Scope
- DB `memories.description String?` 新增与回填
- `platform-mcp` 双工具扩展与落库透传
- `worker-dispatcher.GLOBAL + buildSystemInstructions` 分层索引注入
- `web/memories/page` 已有展开态兼容 `description` 首屏
- 不含向量检索

## Decisions
- `description` 可选，缺省回落 `content.slice(0,120)`，前端优先展示 `description || content.slice(0,120)`
- 动态索引预算 <400 token：各层计数 + Top10 tags + `description` 列表（分页，单次 ≤5 条）
- 多次加载由 Agent 驱动：`memory_search({level/tags/query, limit≤5})` 翻页拉 `content`
- 触发点写入 GLOBAL：启动扫、动工前带 tags 二查、卡点查同类

## Todos
- [x] 1. [server/prisma/schema.prisma] Add `description String? @db.VarChar(255)` to `Memory` model - expect field exists in `prisma generate` output
- [x] 2. [server/prisma] Generate migration `add_memory_description` and run `prisma db push` in dev - expect `SHOW COLUMNS` contains `description`
- [x] 3. [server/src/memories/memories.service.ts#findAll/remove] Return `description` in `select` and support `description` keyword fallback in `where` (content OR description contains) - expect list API returns `description` field
- [x] 4. [server/src/platform-mcp/platform-mcp.tools.ts#memorySaveSchema/memorySearchSchema] Add `description?: string(1..255)` to save, add `description` to search return DTO - expect `memory_save({description:"…"})` succeeds, `memory_search` returns `description`
- [x] 5. [server/src/platform-mcp/platform-mcp.service.ts#memorySave/memorySearch] Persist `description` on create, map to return, fix `assertWorkerTask` pass-through - expect DB row `description` equals input or fallback
- [x] 6. [server/src/chat/worker-dispatcher.ts#GLOBAL+buildSystemInstructions] Rewrite memory paragraph to tag-routed on-demand + add dynamic index block (counts+Top tags+description list, limit 5) before dispatch - expect system prompt contains “可用记忆索引”
- [x] 7. [web/app/(main)/memories/page.tsx#MemoryItem] Extend `MemoryItem` with `description?: string` and render `description || content` as collapsed preview, `content` after expand - expect list首屏 shows description
- [x] 8. [tests] Add `memories.service.spec` case for description round-trip and `platform-mcp.service.spec` case for save with description - expect `npm run test -- memories` pass

## Final verification wave
- [x] F1. Seed description via `memory_save({description:"token刷新踩坑"})` then `memory_search({query:"token"})` returns description
- [x] F2. Dispatch in_progress task → system prompt contains “可用记忆索引” with 3-level counts
- [x] F3. Web memories list shows description truncated 2 lines, click expands to full content
- [x] F4. `memory_search({tags:["auth"],level:"project",limit:2})` returns ≤2 filtered by tags AND

## Must-NOT-Have
- 全量记忆正文自动注入
- 向量库/外部 embedding 依赖
- `description` 必填校验阻断旧数据

## References
- `server/src/memories/memories.service.ts:44`, `server/src/platform-mcp/platform-mcp.service.ts:775`, `server/src/chat/worker-dispatcher.ts:79`, `web/app/(main)/memories/page.tsx:30`
