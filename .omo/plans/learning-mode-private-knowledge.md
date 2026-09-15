# 师徒学习 + 私域知识沉淀 + Librarian（合并计划）

> 起因：用户要“学习模式” skill（学生跟老师单步学，每步最多 5 次工具调用，卡住就问，不自主探索，学完沉淀为业务 skill），后补私域知识需求与只读 Librarian。4 路现状核查（产出物版本/记忆隔离/技能版本/私域读取）已完成，结论见 §2。
> 用户已确认决策：D1 每步 5 次工具调用（先软约束）；D2 挂载所有 Agent；D3 只认触发者；D4 新增 `skill_create` MCP（仅主 Agent，默认停用+人审）；D5 Librarian 放行 `group_post`（回答投递必需）、拒绝 `notify_agent`（防环，别人用 notify_agent 问它）；D6 同团队学习 DM 对 Librarian 开放（带审计，不做全量 DM 开放）。
> 评审记录：Momus 两轮 OKAY；Oracle 一轮 7 项必改已并入（§7）。

## 1. 目标与非目标

- 目标：群里说“进入学习模式”即可带教；学完沉淀 skill + team 记忆 + 产出物归档；只读 Librarian 回答已沉淀知识，不知即认不知；缺的版本/更新/读取能力补齐。
- 非目标：模型微调；新 skill 免审自动上线；跨团队私域共享（默认隔离）；硬性工具计数闸门（本轮只做 prompt 软约束）。

## 2. 现状核查结论（4 路 explore，2026-09-15）

- 产出物：版本链（created/appended/duplicate）+ 验收锁定（acceptedFlag）+ 历史读（全版本/指定版，doclib/read_file 可达）= 支持；**回滚/基线管理 = 不支持**（无 restore/revert/setCurrent，无多基线/Tag；DELETE 删全部版本）。
- 记忆：team 级隔离（teamId 精确 + 跨团队 403）+ 软删（deletedAt）= 支持；**更新/版本/去重/冲突 = 不支持**（仅 GET+DELETE，MCP 仅 save+search，无 version 表，无 hash 查重，并发同内容重复）。
- 技能：停用（无 DELETE，status+广播+worker 清理）= 支持；**版本历史 = 不支持**（Skill 表无 version 列无历史表，update 直接覆盖，fileMeta.version 为 create 时 stale 值，worker 按 enabled+name 写盘，Agent 勾选只存 skillId 永指最新）。
- 读取通道：当前任务域（chat_history 群聊/team 群、task_context、单任务 doclib、单文件 read_file 三级）= 支持；**跨任务检索/全文搜索/目录枚举 = 不支持**；私库无 MCP 一等读通道（靠 worker git_clone/pull + 预下发凭证，worker 级共享非实例隔离，Agent 不能 list）；**私聊 DM 历史不可读**（仅 team_group）。

## 3. 功能清单（P1-P7，含 Oracle 修正）

- P1 `learning-mode` skill：触发词进入→问主题/目标/完成标准→单步（复述→执行→汇报→等下一步，每步 ≤5 次工具调用）→遇错/歧义/多方案停下问→只跟触发者（senderInstanceId）→结束输出三件套（新 skill 草案 + memory 条目 + 归档索引）等确认。
- P2 `skill_create` MCP（仅主 Agent）：入参 `{taskId,teamId,selfInstanceId,name,description,content}`（teamId 必备，走 resolveExecContext 双上下文 + assertWorkerTask/Team）；先 `parseSkillMarkdown(content)`（400 路径）再调 `SkillsService.create`，`file{originalname,size,mimetype}` 由 MCP 输入合成适配（或拆 createCore）；服务端强制 100KB；主身份校验（task.mainAgentInstanceId / team.mainAgentMemberId，否则 403）；默认 enabled=false；注册进 `PLATFORM_MCP_TOOLS` + `VTEAM_MCP_TOOL_NAMES` + `ROLE_SERVER_GATED_TOOLS`（server-gated 透传，不进各角色 toolAllows）。
- P3 skill 版本：`SkillVersion(id skv_+resync, skillId FK, version, content TEXT, fileMeta Json, createdBy, unique(skillId,version))` + `Skill.currentVersion`；migration 必须把现存 skill 回填 v1（取 live content/fileMeta）；`update()` 快照+递增+fileMeta.version 同步包事务；加 rollback/:version；注入仍按 enabled+name（本轮不做按版本 pin）。
- P4 记忆演进：`memory_update`（MCP+REST，按 id+teamId 鉴权：读行→deletedAt 则 404→行 teamId ≠ 执行 team 则 403→global 行仅主可改）；REST `PATCH /memories/:id` 加团队归属校验（现状 AdminGuard 无 scope）；去重用 `contentHash` 列+索引精确命中返 duplicate，相似只做 prompt 合并提示不做阻塞语义；check-then-insert 竞态接受或加唯一键。
- P5 产出物回滚：定 append-as-new（指针回退与 acceptedFlag 审计冲突，放弃）；`restore` 必须绕过 sha256 去重强制新版（`changeNote="restore from vX"`，否则静默 duplicate 不递增）；当前版 acceptedFlag 锁定则 409；调用门限主 Agent/admin；基线 Tag 本轮不做（与“不改表”矛盾，有需要另立）。
- P6 读取补齐：`git-repos.list` 只读 MCP（按 `grantedAgents∋callerInstanceId` 过滤，repoUrl 视同敏感脱敏）+ 目录 list/search；worker 凭证文件为 worker 级共享是已知风险，真隔离需下发期按实例过滤或在 git 执行层强制 permission，本轮先如实披露+文档警示。
- P7 `vteam-librarian` 只读 Agent：允许 `chat_history/task_context/doclib/read_file/memory_search/team_view/my_profile` + `group_post`（回答投递）+ git（clone/pull/fetch/status/diff/log）；拒绝 `notify_agent`（防环）+ `submit_artifact/issue_*/task_transition/memory_save/skill_create/plan_mode/team_add_member/channel_send/wecom_reply` + git push（bash deny 已有 `git push` 模式复用）；私库授权只给 read；`skill_create` 保持 server-gated（librarian 非主即天然拒绝）。落地触点：`VteamAgentName` + `AGENT_POLICIES_ORDER` + `ROLE_BOUNDARIES`（defineBoundary 自动派生 mcpDenies）+ seed + guard `roles.json` + 断言 6 agents 的 spec。回答模板：结论+出处（memoryId/artifactId+version/fileRef）+置信度，无出处固定认不知；永不主动追问。DM 对其开放限定同团队学习 DM + 审计（caller-is-endpoint + 同 teamId + assertWorkerTeam）。

## 4. 任务分解

- [ ] T0 P3 先行 migration：skill_versions 表 + currentVersion 列 + 现存回填 v1（T2 前置，否则 create 无历史可记）
- [ ] T1 P1 SKILL.md 起草→上传→启用→全 Agent 可见验证（种子团队会话：进入→问主题→单步 5 次截断→非触发者消息不推进→总结三件套）
- [ ] T2 P2 `skill_create`：tools.ts schema（含 teamId）+ service（parse 先行+file 适配+归属+主校验+调 SkillsService）+ 三处注册名单 + spec（主放行/非主 403/冒充 403/frontmatter 400/name 重复 409/超 100KB 400）
- [ ] T3 P3 update 追加历史（事务）+ rollback + fileMeta.version 同步修复 + spec
- [ ] T4 P4 记忆：contentHash 列 + memory_update（MCP+REST+鉴权）+ save 查重 + spec（跨团队 403/重复提示/更新鉴权/删后 404）
- [ ] T5 P5 产出物 restore（append-as-new + 去重绕过 + 锁定 409 + 主/admin 门）+ spec
- [ ] T6 P6 读取：git-repos.list MCP（grant 过滤+脱敏）+ 目录 search + DM 历史扩展（同团队+审计）+ spec
- [ ] T7 P7 librarian：Agent 新增（4 处命名/顺序/边界/seed+roles.json）+ ExecutionPolicy 只读边界 + spec（6 agents 断言更新）+ 私库 read 授权 + 问答验收（已知答出+出处/未知认不知/写操作拒绝/不反问）
- [ ] T8 端到端：带教→三件套→skill_create（停用）→人审启用→worker 注入→librarian 答出新知识→回滚演练
- [ ] F1 回归审计（skills/memories/artifacts/platform-mcp 无回归，全量单测）
- [ ] F2 安全审计（主身份校验全覆盖、私库 read-only、无免审启用路径、DM 越权用例、repo 未授权过滤）

## 5. 依赖

```
T0（migration+回填）──→ T2 ──→ T3 ──→ T8
T1（独立，可先行）──→ T8
T4（独立）──→ T8
T5（独立）──→ T8
T6（DM+git list）──→ T7 ──→ T8
F1/F2 ← 全部
```

- 并行：T0 → 后 T1 ∥ T2 ∥ T4 ∥ T5 ∥ T6；再 T3、T7；终 T8→F1/F2。

## 6. 验收标准

- 学习态：非触发者消息不推进步骤；单步超 5 次停下；无明确授权不自主探索（抽查）。
- 沉淀：skill_create 非主调 403；新建默认停用；启用后 worker 落盘；回滚后内容为历史版；现存 skill 已回填 v1。
- Librarian：未知问题回固定不知话术且无编造出处；任何写工具调用被拒；不主动追问；DM 沉淀同团队可查、跨团队不可查；未授权 repo 不在 list 中。

## 7. Oracle 修正追踪（7 项，均已并入正文）

1. skill_create 缺 file 适配/parse 先行/teamId/注册名单/100KB 服务端 → §3 P2、§4 T2。
2. skill_versions 缺回填/事务/顺序（T2→T3 会丢历史）→ T0 前置 + §3 P3。
3. memory_update 缺 teamId 校验/global 主限/REST scope/去重语义 → §3 P4、§4 T4。
4. restore 方案二选一未定 + 去重静默失败 + Tag 与不改表矛盾 → 定 append-as-new、Tag 不做 → §3 P5、§4 T5。
5. git-repos.list 未过滤/脱敏/worker 共享 → §3 P6、§4 T6/F2。
6. DM 全开隐私洞 → 缩为同团队+审计 → D6、§3 P6/P7、§4 T6。
7. librarian 落地触点不全 + notify/group_post 矛盾 → D5、§3 P7、§4 T7。

## 8. 审计记录（F1/F2，2026-09-15）

- F1 全量回归：server 89 suites / 2103 tests，2074 过，29 败。其中 19 个 stash 实证为 pre-existing（notifications 1、message-channels 13、docs-site 5）；workers 5 例症状吻合 pre-existing 但 stash 不可证（HEAD 缺未跟踪的 mcp-discovery.ts 无法编译，且该 spec 为计划改动，留 diff-review）；models 3 + teams-seed 2 与计划无关（未碰对应模块，症状为 DTO/DI wiring，判 likely pre-existing）。E2E 2 suites / 11 tests 全过。双 SkillsService 实例未观测到 id 冲突。
- F2 安全审计（High 3）：H1 git 凭证 worker 级共享（已知）+ repoUrl 可能内嵌 token（新建：create 期需剥离）；H2 global 记忆跨团队可改（共享命名空间设计使然，需产品决策）；H3 DM 历史缺 selfInstanceId 绑定（需补或立文档）。Medium 5（M1 skill_create 双上下文主门确认意图；M2 restore 改 artifacts.edit；M3 git_push 单层依赖待验 guard 层②；M4 SkillsService 改由 SkillsModule 导出；M5 REST/MCP 主体差异 + DELETE 补齐 + 空字串校验）。Low 2（L1 seed 缺 git_repos_list 行、builtin-skill 重跑覆盖 enabled、seed 队无 librarian 待确认；L2 并发竞态已接受）。
- T8 线上验证：T1 走真实 API 闭环（login→上传→启用→content 校验，sk_0000000001）；完整会话级带教循环待重部署后跑。目录 list/search 明确缺口（需 worker 新 HTTP 面，未做）。
- F2 修补批（已落地，模块 specs 全绿 + tsc 干净）：H1-create 期拒 URL 内嵌凭证（400 REPO_URL_CREDENTIALS）；H3-DM 路径强制 selfInstanceId（缺失/冒充 403）；M2-restore 改 artifacts.edit；M4-SkillsService 由 SkillsModule 导出（消双实例）；M5-DELETE 补团队校验 + 空内容 400；L1-seed 补 git_repos_list 行 + 重跑保留 admin 停用。未动：H2（global 共享语义，待产品决策）、H1 执行隔离（架构级，延后）。F1 增补：修补批后 teams/seed 2 败复现（F1 已记 pre-existing，diff 无 teams 文件）。

## 9. 学习闭环实测问题台账（2026-09-15 群聊实测，t_0000000001）

- ISSUE-1 学习回复落私聊：老师在群里说话后，agent 回复大概率先进私聊频道（c_0000000004：m_0000000387/0390/0394），群里需等很久或只看到部分。老师体感是“群里不回复，私聊推一下才动”。疑点：主 Agent 定向 dispatch private 优先、回退群聊。待查群聊无 @ 路由到主 Agent 后的回复通道选择逻辑。状态：待修。
- ISSUE-2 chat_history 语义坑：limit 取最早 N 条而非最近，无 order 参数；返回单行 JSON，read 按行截断（2000 字符）、ripgrep 报 record exceeded（64KB），agent 用满 5 次调用仍定位不到末尾，只能停下问老师。行为本身符合学习模式（诚实停下），工具侧可优化：加 order/desc 或 sinceId 双向。状态：待修。
- ISSUE-3 群聊代码块横向溢出：三件套 ``` 块超出屏幕宽。根因：md-render pre 缺 max-width + 气泡 flex 链缺 min-width:0。状态：已修（chat-bubble minWidth:0/maxWidth 100%/overflow hidden + md-render pre 约束，截图验收：pre 右缘 1624→922，文档横向溢出 0）。
- 测试备注（非产品问题）：多 agent 共用一个 playwright 会话会互相顶掉页面（about:blank），冒烟时重进一次解决。
- ISSUE-4 新 MCP 工具对存量会话隐身：部署新增 skill_create/memory_update/git_repos_list 后，老 opencode 会话函数列表里没有它们（工具定义会话启动时冻结），agent 自查以为“没权限”，向老师报卡住（m_0000000405）。profile 的 serverGated 名单是对的。短期：加工具后重启 worker 会话（本次 worker 已重启，新会话自动带新工具）；长期：reload-config 应刷新会话工具定义。状态：已记录，长期修延后。
- ISSUE-5 确认语歧义导致自动入库：老师说“三件套确认可用”后，agent 把评价语当成沉淀授权，自行 memory_save 两条（me_0000000001/2，03:26），而老师此前明确过“只发文本不要调用”。已修：learning-mode §7 加入库门（仅“可以入库/开始沉淀/调用 skill_create”等明确指令算授权，评价语不算，逐项报备），§4 加工具缺失判据（先查 my_profile serverGated，会话旧则问老师重启或代建）；线上 skill 已更新到 v3。去重验证：agent 用同款内容再调 memory_save 返回 duplicate，记忆总数保持 2。
- 沉淀闭环结果：chat-history-query（sk_0000000002，默认停用）由老师代建；2 条 team 记忆在库；去重行为线上验证通过。
- librarian 实测（tmm_0000000007，已加入种子团队）：已知问题（limit 语义）引用 me_0000000001 作答 + 置信度（m_0000000421）；未知问题（线上事故根因）回固定不知话术并列出检索范围（记忆无相关条目、文档库 3 个产出物无关、无授权仓库，m_0000000425）。只读两问皆过。
- 协作 5 幕剧本实测：Act1 求助接力 ✅（测试→开发→回群，约 13 分钟，请求格式规范、附件交接完整）；Act2 越界转交 ✅（开发拒绝代判验收→转交 PM→PM 组织→点名测试出正式结论，约 3 分钟，全程带证据指针）；Act3 失败升级 ✅（notify 不存在实例报 PLATFORM_MCP_TASK_NOT_FOUND，经 team_view 核对 7 成员，给出替代路径，不伪造成功）；Act4 广播纪律 ❌（@all 私域问题引 6 成员群答：PM/产品/架构/测试/计划各答一遍 + 两条收尾 @all，librarian 按规矩回不知因为无沉淀——对的是它，错的是缺广播纪律机制）；Act5 定向问答 ❌（@开发者-1 问沉淀问题 12 分钟无回复，无超时跟进/升级）。结论：点对点配合顺畅，广播必炸，定向 @ 无 SLA。下一步：写《团队协作规约》（求助三要素/转交落 issue/广播纪律）+ 转交响应度量。
- F2 修补批（已落地，模块 specs 全绿 + tsc 干净）：H1-create 期拒 URL 内嵌凭证（400 REPO_URL_CREDENTIALS）；H3-DM 路径强制 selfInstanceId（缺失/冒充 403）；M2-restore 改 artifacts.edit；M4-SkillsService 由 SkillsModule 导出（消双实例）；M5-DELETE 补团队校验 + 空内容 400；L1-seed 补 git_repos_list 行 + 重跑保留 admin 停用。未动：H2（global 共享语义，待产品决策）、H1 执行隔离（架构级，延后）。F1 增补：修补批后 teams/seed 2 败复现（F1 已记 pre-existing，diff 无 teams 文件）。
