-- 回执账本「结账原因」列（pm-coordination-hardening 批次 A4，2026-10-22）
--
-- 背景：批次 A4 给回执账本补了**减法**——账本第一次能往下走（引用即销账 /
--   question 应答后结账 / 被 supersede 的旧派发结账）。此前账本只有**加法**
--   （每次 notify_agent 加一行，me_0000000030：「别用 notify 清回执，会越清越多」），
--   而 status 词表只有 pending|acked|expired ⇒ 一行被结掉之后，**无从分辨它是
--   「谁回了执」还是「平台按引用/应答/被替换替它结的」**。审计与排查（尤其是
--   「为什么这条派发不再被追了」）只能靠猜。
--
-- 本列只补这一条审计语义，**不改 status 词表**（pending|acked|expired 保持不变）：
--   - 新增一列 `settled_reason`（可空字符串）；
--   - status='acked' 时写入结账依据：answered / quoted / question-answered / superseded；
--   - status='expired' 时留 NULL——过期本身已由 status 说明，不重复记账；
--   - 历史行一律 NULL（未回填）：历史账本没有记录依据，**不猜**。
--
-- 为什么是「追加迁移」而不是改 baseline（docs/migration-baseline.md）：
--   baseline 是 2026-09-25 从整库 dump 折叠出来的**历史事实**，已部署库按目录顺序
--   逐条写 `_prisma_migrations`；回头改 baseline 对已部署库是静默 no-op，只会在文件
--   与真实库之间留下永久漂移。**不得**编辑
--   `server/prisma/migrations/20260925000000_squashed_baseline/migration.sql`。
--
-- 列型：varchar(191) NULL——与本表其它可空 varchar（force_reason 等）一致；
--   取值域极小（4 个短串），191 纯富余。
-- 零回填/零 UPDATE/零 DELETE/零索引：本列不参与任何查询谓词（只随行读出做审计展示），
--   建索引只会给这张热表白加维护成本。
-- 不建外键、不动既有列/索引 ⇒ 可安全重复执行（重复执行会因列已存在而报错，
--   与本仓其它 ADD COLUMN 迁移同形态：migrate deploy 按目录顺序只跑一次）。

ALTER TABLE `message_receipts`
  ADD COLUMN `settled_reason` varchar(191) NULL;
