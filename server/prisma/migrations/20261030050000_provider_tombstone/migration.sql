-- Provider 删除意图（tombstone，2026-10-30）
--
-- ── 为什么需要本迁移 ────────────────────────────────────────────────────
-- `DELETE /models/providers/:providerID` 物理删除模型行后，下一次
-- `POST /models/sync` 仍会把 provider 带回来：sync 的 live 集是**所有在线
-- worker 的模型并集**，而外部节点（keta，worker-37）自带自己的 opencode 环境，
-- 那里配置过的 provider 会被持续上报——vteam 侧删得掉库行，删不掉别人环境里的
-- 真实服务。线上实测：删除 minimax-cn-coding-plan 后刷新即复活
-- （live=112 = 集群 worker 110 + keta 上报的 minimax 2）。
--
-- ── 语义 ────────────────────────────────────────────────────────────────
-- - 删除 provider → 落一行 tombstone（幂等 upsert）；
-- - syncLiveModels / syncFromWorkerCapabilities / listProviders 忽略 tombstoned
--   provider 的 live 上报——**删除意图压过引擎真值**，直到显式重新添加；
-- - 重新添加（保存凭据 POST credentials、新建模型 POST /models）→ 清除该行，
--   随后的 sync 自然把 provider 带回列表；
-- - 行只有 provider_id（PK）与 deleted_at：无 FK（不与任何域的删除编排耦合，
--   对齐 model_credentials 的逻辑关联惯例），无回填（存量删除无法诚实重建）。
--
-- 表极小（仅删除过的 provider 一行一条），查询全量入内存无索引需求。

CREATE TABLE `provider_tombstones` (
  `provider_id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `deleted_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`provider_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
