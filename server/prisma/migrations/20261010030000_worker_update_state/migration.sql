-- worker 自更新执行状态 + 回滚结果（worker-self-update Todo 3，2026-10-10）
--
-- 背景：`update-worker` 指令本身**不落库**（命令一次有效，心跳取出即清空，沿用
-- T4a pendingCommands 语义）。但 worker 上报的两项是**「上次更新结果」的事实**，
-- UI 必须在 server 重启后仍能展示：
--   - update_state：pending / downloading / restarting / ready-manual / rolledback
--     （worker 执行器状态机的当前值，契约常量见 src/workers/worker-update-state.ts，
--      与 Todo 4 worker 执行器、Todo 5 web UI 三方逐字对齐）；
--   - rolled_back：最近一次自更新是否被自动回滚（一次性结果标志，可保持 true）。
-- 纯内存态会让 server 一重启就把「已回滚」悄悄变回「未回滚」——那是最不该被
-- 吞掉的一条运维事实。指令（瞬时）与事实（可追溯）刻意分库存放。
--
-- 列语义：
--   - update_state `varchar(191) DEFAULT NULL`：NULL = 从未上报（旧版 worker 不带
--     该字段，或该 worker 还没自更新过）= 未知，UI 显示未知而非假装一致。
--     191 = 本仓所有字符串列统一宽度（与 code_version / default_model_id 同口径）。
--     register/heartbeat **缺席即不写该列**（保留上次值），语义与 code_version 一致。
--   - rolled_back `BOOLEAN NOT NULL DEFAULT false`：false = 没有回滚发生过的证据。
--     取 NOT NULL 而非可空，是为了让前端拿到二态而不是 null/false/true 三态。
--
-- 不建索引：workers 表行数为外部 worker 个位数，两列只随整行读回展示，不参与
-- 任何 where/orderBy 过滤 → 索引只有写放大没有收益（与 code_version 同判断）。
--
-- 零回填：存量行是「这两列诞生之前」的 worker。update_state 回填成任何具体状态
-- 都是凭空断言（它们可能从未执行过自更新）；rolled_back 的 false 恰是诚实的默认值
-- ——「无回滚证据」而非「确认无回滚」，故此处不需要 UPDATE。
--
-- 手写 DDL：本机/CI 无 MySQL（`nc -z localhost 3306` 不通），本文件为手写，
-- 列类型/默认值/顺序与 Prisma 自产结果**逐字等价**（离线 `prisma migrate diff
-- --from-schema-datamodel <迁移前 schema> --to-schema-datamodel prisma/schema.prisma
-- --script` 输出：
--   ALTER TABLE `workers` ADD COLUMN `rolled_back` BOOLEAN NOT NULL DEFAULT false,
--       ADD COLUMN `update_state` VARCHAR(191) NULL;
-- 等价性由 src/prisma/worker-update-state.migration.spec.ts 守卫）。

ALTER TABLE `workers`
  ADD COLUMN `update_state` varchar(191) DEFAULT NULL,
  ADD COLUMN `rolled_back` boolean NOT NULL DEFAULT false;