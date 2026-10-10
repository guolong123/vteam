-- worker 代码版本可见性（worker-self-update Todo 2，2026-10-10）
--
-- 背景：worker 自更新需要「当前 vs 期望」两把尺子。期望版本来自 server env
-- `CODE_VERSION`（deploy-k8s.sh 注入 deploy TAG，天然与 pack-worker tarball 同源），
-- **不落库**——它是部署期常量，写进库只会在回滚/多套环境时制造第二真相。
-- 当前版本必须由 worker 自己上报（各 worker 可能滚动升级到不同版本，同一 deploy
-- TAG 下也会分化），落 `workers.code_version`。
--
-- 列语义：`varchar(191) DEFAULT NULL`，NULL = 从未上报 = 版本未知。
--   - 与 `default_model_id` 同口径的「可选事实」列：register/heartbeat 缺席即
--     **不覆盖已有值**（旧 worker 缺席不清空新 worker 已上报的版本）；
--   - 191 = 本仓所有字符串 id/短标识列的统一定长（utf8mb4 索引前缀上限兼容）。
--
-- 不建索引：workers 表行数为外部 worker 个位数，版本字段只随整行读回展示，
-- 不参与任何 where/orderBy 过滤 → 索引只有写放大没有收益。
--
-- 零回填：存量行是「本列诞生之前注册的 worker」，它们的代码版本无从重建
-- （注册时不带版本 = 未知，而不是某个具体 SHA）。回填成 server 的 CODE_VERSION
-- 会凭空断言这些 worker 跑的就是那个版本——那正是本列要消灭的谎言。
-- NULL 才是诚实的取值，且与旧 worker 兼容路径（同一条）天然重合。

ALTER TABLE `workers`
  ADD COLUMN `code_version` varchar(191) DEFAULT NULL;