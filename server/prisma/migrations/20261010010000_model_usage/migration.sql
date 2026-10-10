-- 用量记录表（token-usage-stats Todo 2，2026-10-10）
--
-- 一张「成员 × 模型 × 调用」粒度的用量与费用行表：worker 的 step-finish 用量经
-- TASK_COMPLETED 事件透传后由 usage-sink 落本表（Todo 3），聚合计数接口读本表
-- （Todo 4）。本迁移只负责建表与建索引，**不含任何回填**。
--
-- ── 为什么只建表不回填 ──────────────────────────────────────────────────
-- 迁移前的历史用量**无法诚实重建**：`TASK_COMPLETED` 事件体早已携带 tokens/cost，
-- 但旧消息只把正文落进 `messages.content.parts`，事件体本身被丢弃。要回填只能去
-- 反解 parts 里的残留结构——那是 best-effort 的二次解析，缺字段就少算、按残缺值
-- 记账等于凭空造数。故本表**只记新数据**：`created_at` 从零开始积累。
--
-- ── 费用语义：不建单价表、不重算 ──────────────────────────────────────────
-- `cost` 直存 worker 上报的**原值**（DOUBLE，NULL = 上游未给 = 未知）。
-- 本仓没有权威价目表，任何"按 token 数 × 单价重算"都是在凭空造一套口径，
-- 且调价时会与历史行的含义分裂。NULL 与 0 语义不同（未知 ≠ 免费），
-- 故列可空、且不做 DEFAULT 0。
--
-- ── 六个 token 计数的可空性 ──────────────────────────────────────────────
-- 全部 `int NOT NULL DEFAULT 0`（与 `Memory.refCount` 同一口径）。worker 侧
-- `ServeTokens` 是 best-effort，缺字段/NaN 由服务层 `Number.isFinite` 归零后
-- 写入——库侧用 DEFAULT 0 兜底，脏数据归零不断链，而不是让一行统计因某个
-- 字段缺失整条写不进去。
--
-- ── 不建外键（软关联）────────────────────────────────────────────────────
-- team_id / team_member_id / session_id / channel_id / agent_id / task_id 一律
-- 只存 id 串。对齐本仓既有跨域表惯例（`message_receipts` / `triggers` /
-- `message_deliveries` 的 id 列均为逻辑关联）。用量是**只读审计事实**，
-- 不参与任何域的删除编排：建 FK 会让删会话 / 删成员 / 删团队的既有 RESTRICT
-- 删除路径被一张统计表连带卡死——纯粹的跨域耦合负债，换不到任何一致性收益。
--
-- ── 三条索引 ────────────────────────────────────────────────────────────
-- - `idx_usage_team_member (team_id, team_member_id)`：成员透视聚合的主路径
--   （`GET /teams/:teamId/usage` 的 `groupBy [teamMemberId, model]`）。
-- - `idx_usage_team_model (team_id, model)`：模型维度过滤与 `?model=` 精确过滤。
-- - `idx_usage_created (created_at)`：时间维度游标/预留切片（本版接口只做累计，
--   但表结构先留索引，避免日后加时间序列时全表扫描）。
--
-- ── 主键 ────────────────────────────────────────────────────────────────
-- `id` 为 `us_` 前缀 + 零填充序号（`IdGeneratorService`，对齐 Memory 的 `me_`）。
-- 续号责任在**消费侧**：`usage-sink` 的 `onModuleInit` 必须调
-- `resyncIdPrefix(this.prisma.modelUsage, 'us', this.idGen)`，
-- 否则重启后计数器归零、`nextId('us')` 撞既有主键 P2002
-- （同源事故固化见 `server/src/common/id-resync.guard.spec.ts`）。
-- 本迁移只建表，故无 seed、无 DEFAULT——主键永远由服务层显式写入。

CREATE TABLE `model_usages` (
  `id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `team_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `team_member_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `session_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `channel_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `agent_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `task_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `model` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `input_tokens` int NOT NULL DEFAULT 0,
  `output_tokens` int NOT NULL DEFAULT 0,
  `reasoning_tokens` int NOT NULL DEFAULT 0,
  `cache_read_tokens` int NOT NULL DEFAULT 0,
  `cache_write_tokens` int NOT NULL DEFAULT 0,
  `total_tokens` int NOT NULL DEFAULT 0,
  `cost` double DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_usage_team_member` (`team_id`,`team_member_id`),
  KEY `idx_usage_team_model` (`team_id`,`model`),
  KEY `idx_usage_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;