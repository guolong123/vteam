-- 一个成员在一个团队只能有一个席位（2026-11-17）
--
-- 背景：MCP 工具身份从「席位 id（tmm_）」改为「平台成员 id（mbr_）」后，
-- 需要从 memberId 唯一确定该成员在目标团队的席位。此前只有
-- uk(team_id, agent_id, seq)，同成员同团队可插入多条席位 ⇒ 无法唯一确定。
--
-- 前置核对（2026-11-17 线上）：43 个席位全部绑定 member_id，且
-- (member_id, team_id) 无重复 ⇒ 加约束不会失败。
-- member_id 可空（历史未绑成员的席位）；MySQL 唯一索引允许 NULL 重复。
--
-- 索引名手工压到 ≤64 字符（MySQL 限制）。

ALTER TABLE `team_members`
  ADD UNIQUE INDEX `uk_team_members_member_team` (`member_id`, `team_id`);
