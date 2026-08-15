-- AlterTable `task_agents`：is_0000000010 每 agent 独立工作目录绑定
-- work_dir 可空（存量实例按默认规则动态解析 /data/worker/<sanitize(agent.name)>，不改历史行）
ALTER TABLE `task_agents` ADD COLUMN `work_dir` VARCHAR(255) NULL;
