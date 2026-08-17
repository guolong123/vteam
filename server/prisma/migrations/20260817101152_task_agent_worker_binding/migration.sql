/*
  Warnings:

  - You are about to alter the column `work_dir` on the `task_agents` table. The data in that column could be lost. The data in that column will be cast from `VarChar(255)` to `VarChar(191)`.
  - Made the column `task_agent_id` on table `sessions` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `sessions` MODIFY `task_agent_id` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `task_agents` ADD COLUMN `worker_id` VARCHAR(191) NULL,
    MODIFY `work_dir` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `task_agents` ADD CONSTRAINT `task_agents_worker_id_fkey` FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_task_agent_id_fkey` FOREIGN KEY (`task_agent_id`) REFERENCES `task_agents`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
