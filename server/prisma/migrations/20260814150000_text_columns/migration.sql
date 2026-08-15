-- AlterTable
-- 任务/issue 描述改 TEXT：VARCHAR(191) 容量不足，用户提交超长 description 落库 500
-- （K8s 部署报 value too long for column description；同类先例：Agent.prompt / Skill.content 已 TEXT）
ALTER TABLE `tasks` MODIFY `description` TEXT NULL;
ALTER TABLE `issues` MODIFY `description` TEXT NULL;
-- 同类预防：project/skill 描述同为无 MaxLength 约束的用户长文本输入（description 类一起修）
ALTER TABLE `projects` MODIFY `description` TEXT NULL;
ALTER TABLE `skills` MODIFY `description` TEXT NULL;
