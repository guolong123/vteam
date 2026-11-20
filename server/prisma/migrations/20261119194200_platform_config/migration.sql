-- 平台配置表（会话上下文压缩等运行期可调参数）
--
-- 背景：会话压缩的阈值参数（不活跃天数、上下文下限、等待/超时预算）需要
-- 平台管理员在界面上直接改，而不是改 env 后重启服务 ⇒ 需要一张「键值配置」表。
--
-- 为什么用键值表而非每参数一列：新增一个配置项 = 加一条常量（默认值/说明），
-- 表结构不变，迁移零成本；值合法性由服务层按 value_type 校验（数字越界、
-- 非法枚举拒绝落库）。
--
-- id 由服务层 IdGeneratorService 生成（`pc_` 前缀 + 零填充序号），本表无自增列。
-- 迁移链只跑 MySQL（SQLite 测试库走 `prisma db push`，不写兼容逻辑）。

CREATE TABLE `platform_configs` (
  `id` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `key` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `value_type` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_by` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `platform_configs_key_key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
