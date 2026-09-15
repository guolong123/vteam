-- AlterTable
ALTER TABLE `memories` ADD COLUMN `content_hash` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `idx_memories_content_hash` ON `memories`(`content_hash`);
