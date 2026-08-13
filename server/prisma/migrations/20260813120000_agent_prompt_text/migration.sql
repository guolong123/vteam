-- AlterTable
-- 出厂默认提示词升级为多段长文本（16 篇 §3~§7 四方向结构），VARCHAR(191) 容量不足。
ALTER TABLE `agents` MODIFY `prompt` TEXT NOT NULL;
