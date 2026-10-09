-- 记忆引用计数指标（2026-10-09）
--
-- 1) 新增 `ref_count`：agent 经 memory_search 主动命中 +1（**自动注入不计**）。
--    存量行一律保持 DEFAULT 0，不回填——历史行没被计量过，臆造一个引用数
--    会直接污染重要度排序（旧行会因为 fake refCount 压过全新记忆）。
--    refCount=0 正是「未被引用过」的诚实取值，由时间新鲜度项接管排序。
-- 2) 新增 `last_used_at`：最近一次被检索命中的时刻，NULL = 从未被引用。
--    重要度计龄基准 = last_used_at ?? created_at（见 memory-importance.ts）。
-- 3) 新增 `merged_into_id`：合并追溯（本行已被并入哪条记忆），只读标记，
--    不建外键——合并是历史事实，外键会连带限制胜出行的清理。
-- 4) 新增单列索引 idx_memories_ref_count，支撑注入候选 `orderBy refCount desc`
--    的预筛（预筛后在内存按重要度精排取 top5）。
--
-- 不动 task_id / idx_memories_task_time：task 级记忆虽已废弃（服务层 400 拒收），
--    但删列是不可逆 DDL，若其他环境残留 task 级数据会直接丢失。保留死列零成本。

ALTER TABLE `memories`
  ADD COLUMN `ref_count` int NOT NULL DEFAULT 0,
  ADD COLUMN `last_used_at` datetime(3) DEFAULT NULL,
  ADD COLUMN `merged_into_id` varchar(191) DEFAULT NULL;

CREATE INDEX `idx_memories_ref_count`
  ON `memories` (`ref_count`);