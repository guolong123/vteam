-- 项目经理岗位边界「行业分工映射」清空（pm-coordination-hardening 批次 E，2026-10-22）
--
-- 背景：`ROLE_BOUNDARIES['vteam-project_manager'].handoffTo` 出厂带一张**研发团队**
-- 分工表（requirements→vteam-product、design→vteam-architect、code→vteam-developer、
-- test→vteam-tester、plan→vteam-plan），它会被渲染进每次派发的【职责边界】段：
--   「…通过 vteam_notify_agent 或群聊 @ 转交对应角色（requirements→vteam-product、…）」
--
-- 为什么是缺陷而不是特性：项目经理是**通用入口**（任意团队的第一接收人）。批次 D 已把
-- 它的纪律改成岗位无关（「产出归谁由各岗位职责界定」），但这张表仍把研发岗位映射硬塞
-- 回模型视野 —— 模型读到枚举会退回「代码→开发者」的固定反射，反而压过岗位判定。
-- 非研发团队（法务/研究/运营）读到的是与本团队无关的分工 ⇒ 边界段自相矛盾。
--
-- 改法：把 PM 的 `config.correction.handoff` 置为空对象。
--   - 渲染：`renderBoundarySection` 对空映射**省略括号**（收尾为「…转交对应角色。」），
--     不再吐出空括号；其它岗位的非空映射渲染不变。
--   - 越界话术：worker guard 的 `buildDenyMessage` 在映射为空时兜底为「对应职责角色」
--     （`role-guard-plugin`），因此不会出现空白的转交目标。
--   - 归属判定交给团队成员名册 + 各岗位自身职责（管理员可配置）——这正是批次 D 的口径。
--
-- 为什么用迁移而不是只改常量：seed 的 ExecutionPolicy upsert 是 `update: {}`
-- （create-if-absent，不回滚用户编辑）⇒ 重跑 seed 不会推给存量部署。
--
-- 守卫：只认**出厂那张表**（5 个 scope 且 5 个目标逐一相等）。管理员自定义过映射
-- （增删 scope 或改目标）⇒ 条件不成立 ⇒ 本迁移不碰它。
--
-- 幂等：置空后 `JSON_LENGTH(...)` 为 0 ⇒ 重跑 0 行受影响；不 INSERT / DELETE / DDL。
--
-- 回滚：反向 `JSON_SET` 回填那张出厂表即可（内容见 20261023000000 之前的内置常量历史）。

UPDATE `execution_policies`
SET `config` = JSON_SET(`config`, '$.correction.handoff', JSON_OBJECT()), `updated_at` = NOW(3)
WHERE `id` = 'ep_project_manager'
  AND JSON_LENGTH(JSON_EXTRACT(`config`, '$.correction.handoff')) = 5
  AND JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.correction.handoff."requirements"')) = 'vteam-product'
  AND JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.correction.handoff."design"')) = 'vteam-architect'
  AND JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.correction.handoff."code"')) = 'vteam-developer'
  AND JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.correction.handoff."test"')) = 'vteam-tester'
  AND JSON_UNQUOTE(JSON_EXTRACT(`config`, '$.correction.handoff."plan"')) = 'vteam-plan';
