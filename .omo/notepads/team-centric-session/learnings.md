# Learnings — team-centric-session

Conventions, patterns, and successful approaches discovered during work on this plan.

_Auto-scaffolded by /start-work. Append new entries below - never overwrite._

---
## 2026年 9月 2日 星期三 16时35分11秒 CST Task 1-6 completed: team session page, nav unified, docs updated, build passed

## 2026-09-07 admin 团队会话修复：seed 漏配 u_admin 的 team_user_members 行
- 现象：fresh deploy 下 admin 登录打不开团队会话（"暂无团队群聊频道"）；根因 seed 只给 seed-admin 落 team_user_members owner 行，findAccessibleChannels 对非成员返回空集，admin 永远到不了 ensureTeamChannel 的自愈分支。
- 修复 = 仅加一行 membership：seed.ts 新增 upsert（id tum_admin_seed，team tm_0000000001 × user adminUser.id，role owner，注释说明开箱管理）；seed.spec 新增断言（2 行 upsert、create id 集合、role=owner）。
- 线上修复只做单条 INSERT（先 SELECT 确认缺行，再 INSERT，再 SELECT 验证），证据 .omo/evidence/compose-smoke/admin-team-access.log；截图 admin-session.png（平台管理员视角群聊正常渲染）。
- 教训：凡 seed 绕开 Service 层直写关联表，必须逐一核对"每个登录账号 × 每张成员表"的覆盖矩阵；平台管理员账号尤其容易被遗漏。
- 细节：docker exec 进 mysql 取密码必须用容器内 $MYSQL_ROOT_PASSWORD（bash -c 单引号包裹），宿主机侧切勿 -p 明文；浏览器复用 profile 会残留旧登录，取证前先退出再 fresh login。

## 2026-09-07 session-unification Todo 6 联动：TaskAgent 域删除（本 notepad 仅记录交叉影响）

- teams 表新增 managed_mode（默认 false，seed 零改动靠 DB 默认）；tasks.managedMode 列删除——读托管开关统一走团队行（Todo 9 消费）。
- 破坏性变更备份：.omo/evidence/session-unification/su6-backup-20260907-213137.sql（mysqldump，compose 本地库）。
- 团队会话直聊/群聊写路径不受影响（Todo 4/10 已收敛 taskId/taskAgentId=null）；残留 prisma.taskAgent 服务引用由 Todo 9/11 收敛，期间 tsc 断档为计划内。

## 2026-09-07 session-unification Todo 9 联动：记忆/托管团队化（本 notepad 仅记录交叉影响）

- 记忆 level 只剩 team/global（task 级 400 MEMORY_LEVEL_INVALID）；团队直聊/群聊 prompt 的记忆索引块只计 team+global（分派仍仅任务模式注入，team 直聊 system 字节不变）。
- 托管开关改读团队行（Teams 更新 managedMode 生效；tasks 创建/更新不再接受 managedMode）；问题确认门（question_confirm + WeCom 自循环门）改 team.mainAgentMemberId 判定；问题事件 scope 改 team 域（前端订阅 Todo 12 衔接）。
- 本 notepad 计划文件不动；实现细节见 session-unification learnings Todo 9 节。

## 2026-09-08 session-unification Todo 15：种子 idGen 续号跳过非数字 id
- 根因（T14 FAIL 表）：team_user_members 混入 `tum_admin_seed` 后，teams/tasks/chat/artifacts 四处内联 seedPrefix 用 `findFirst orderBy id desc` 取字典序最大行（'tum_admin_seed' > 'tum_0000000001'），parseInt 得 NaN → 跳过 seed → 计数器从 0 起 → 首个 nextId 撞主键 → 建团队首试 500。
- 修复 = 删 4 处内联 seedPrefix（含 SeqModel 别名）+ onModuleInit 改调共享 `resyncIdPrefix`（findMany 按 `<prefix>_` 过滤、JS 侧仅统计纯数字尾号取 max；全非数字表不 seed 不抛错）。其余服务此前已迁移，本 Todo 后 `seedPrefix|SeqModel` 在 src 下零命中（回归 spec 注释提及除外）。
- 回归 `server/src/teams/seed.spec.ts`：mock 表态复刻 fresh-seed（`tum_0000000001` + `tum_admin_seed` 共存，findFirst 仿真 desc 取到非数字行）→ 修复前红（得 ...0001）、修复后绿（得 ...0002）；全非数字表单测锁定不抛错、从 1 起。4 个既有服务 spec 的 onModuleInit 断言同步改 findMany mock。
- 证据：`.omo/evidence/session-unification/su15-happy.log`（5 套件 311 用例 EXIT 0）、`su15-failure.log`（全非数字单测 EXIT 0）、`su15-tsc.log`（tsc --noEmit EXIT 0）；共享 DB 未动（全 mock，无 live）。
