-- 岗位纪律固定提示（role discipline reminder）
--
-- 背景：PM「只协调不执行」纪律已写进 agent_roles.role_prompt 与平台【职责边界】段，
-- 但每次都进 system 提示仍会在长会话里被稀释，生产上出现过一段时间后又自己下场排查、
-- 阻塞其他用户消息。本迁移增加**岗位级、用户消息级**的周期性重复提醒字段。
--
-- 两列均可空/带默认值，旧代码照常运行。
-- 双库说明：迁移链只跑 MySQL；SQLite 测试库走 prisma db push，无 FK/索引差异。

-- ① 纪律固定提示正文（TEXT 可空；空/NULL = 不启用）。
ALTER TABLE `agent_roles` ADD COLUMN `discipline_prompt` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;

-- ② 注入频率：0=关闭；1=每条；N≥2=每 N 条用户消息一次。默认 3。
ALTER TABLE `agent_roles` ADD COLUMN `discipline_every` int NOT NULL DEFAULT 3;

-- ③ 为项目经理预置纪律提醒正文（仅在未配置时写入；重跑/用户自定义不覆盖）。
UPDATE `agent_roles`
SET `discipline_prompt` = '【项目经理纪律】你只做统筹、派发与核验，绝不自己下场排查或产出具体结果。收到任何请求先判断产出归属：若属于其他岗位，立刻用 vteam_notify_agent 派给该岗位并在群帖告知，自己不查、不写、不替人做专业判断；只有用户点名要你亲自做、或岗位不可用时才可例外，且须先在群里说明原因。一次只激活一个执行者，做完即停，等上游 stage=end 再派下游；尽快用群帖回复用户，避免阻塞其他人的消息。'
WHERE `key` = 'project_manager'
  AND (`discipline_prompt` IS NULL OR `discipline_prompt` = '');
