# 平台技术设计 · learnings（09 篇 API 设计）

- 08 篇 §3.2 的 `/api/workers/register` 与对外 REST 基础路径 `/api/v1` 前缀冲突：09 篇统一收敛为 `/api/v1/workers/register`，通过「前缀收敛说明」处理而非修改 08 篇（不动既有文档）。
- 消息历史游标与 SSE 事件 id 同源（均用消息主键）：既保证 REST 历史与实时流无缝衔接，又让断线续拉（since）与历史兜底（cursor）共用同一套语义，无需维护两套游标体系。
- 产出物落库主路径是 worker 事件驱动（task.completed / message.part.delta 的 file part），API 只提供成员辅助提交 P1 入口——避免为 Agent 回调设计专用 REST 端点造成「Agent 直连控制面 API」的语义混乱。
- 工具不提供 DELETE：工具名即权限 action（FR-48），删除会导致历史 Agent 配置悬空，用停用（enabled=false）替代，与 FR-35 启用开关语义对齐。
- worker 注册/心跳端点认证与用户 JWT 完全隔离（X-Worker-Token）：对外 API 是用户业务契约，worker 协议是引擎 Driver 远程化（07 篇 11.3），两套契约由控制面唯一翻译，任何一端演化不影响另一端。
- @ 触发的同步/异步割裂：POST 消息同步返回 triggers（受理状态），处理结果全走 SSE（loading→chunk/error→final）——前端需按 messageId 聚合三态，API 设计时保证事件时序固定。
- 错误响应统一 {code, message, details?} 与业务码前缀（VALIDATION_/AUTH_/PERMISSION_/NOT_FOUND_/CONFLICT）让前端可编程处理；状态迁移非法统一 409 *INVALID_TRANSITION。
- 角色权限矩阵「删除」操作与端点对齐：矩阵仅对可删对象（项目成员移除、自定义角色删除）开放 DELETE，任务/消息/产出物无 DELETE 端点——权限矩阵与 API 面一一对应，避免空权限点。
- 群聊专章（§6）采用「生命周期主线」而非按端点组织：消息模型→频道→@触发→消息流→历史游标→状态机→边界，把 §3.5/§4.2/§5.1 中分散的契约串成完整机制图景；与 §5.1 已有详设用「引用+扩展」衔接，不重复 8 步流程与 DTO。
- 消息主键 id 兼任三重身份（消息主键 / SSE 事件 id / 历史游标），群聊专章据此把断线补拉（since）与历史兜底（cursor）统一为同一套语义，§6.5 明示「同源」关系。
- 消息 status 字段区分两类生命周期：用户消息 sending→sent（瞬时→稳定）；Agent 回复 pending→processing→completed/failed（对应 dispatch 状态机）——前端按 messageId 聚合 loading→final/error 三态，事件时序固定是 API 层必须保证的约束。
- Part 展示规则是「进群聊 vs 只进会话流」的过滤层（FR-18）：reasoning 折叠、tool 卡片三态、file 入文档库、aborted 显示已中断；内部片段（step-start/patch/snapshot/compaction）不渲染不广播——群聊整洁性由 Part 级过滤保证，而非仅靠事件级过滤。
- 新增章节导致后续章节顺延时，交叉引用必须同步：本文档内 7 处「（§6）→（§7）」「（§7）→（§8）」逐一核对更新，用精确字符串断言（count==1）防漏改。
- 专章升级独立文档时采用「引用段占位」而非「编号顺延」：09 篇 §6 替换为指向 10 篇的引用段，后续 §7/§8/§9 编号不动——避免大范围交叉引用更新，是小型文档迁移的首选策略（改动面从 7 处引用降为 1 处）。
- 独立文档补全的三类内容各有用途：UI 映射（§2.3）解决「Part 展示规则如何落成气泡形态」的产品空白；stateDiagram（§7.1）把文本状态机变成可视化；模块交互（§8）补齐系统消息的触发来源——迁移不是搬运，是借机补全原专章未展开的部分。
- 迁移时交叉引用改写规则：原 §6 内指向本文档内部的 `§3.5`/`§4.2`/`§5.1` 等全部加「09 篇」前缀，指向外部文档的（08 篇 §6.3 等）保持原样——grep 验证时注意区分，避免把 08 篇引用误改。

# 平台技术设计 · learnings（11 篇 资源与注册机制）

- 任务描述中的「FR-40 工具权限」与 04 篇原文不符（FR-40 实为「结论文本直接归档」，工具权限是 FR-35/FR-48）——撰写时以 04 篇实际编号为准引用 FR-27/FR-34/FR-35/FR-48，不照抄任务里的错误编号；工具权限落点统一写 FR-35/FR-48。
- 官方 skills 文档明确 frontmatter `description` 也是必填（任务描述写「name 必填/description 可选」有误）——以官方文档为准（name/description 均必填，name 正则 `^[a-z0-9]+(-[a-z0-9]+)*$` 且须与目录名一致），v2 的 slash/文件名推断标注为「调研预期」而非既成事实。
- MCP 工具命名是两段式 `<server>_<tool>`（官方原文 "registered with server name as prefix"），不是三段式——官方示例 `"mymcpservername_*": false` 即为此命名空间的通配覆盖写法；自定义工具具名导出同样是 `<filename>_<export>` 两段式，两个命名空间可能重叠，是 §9 边界问题的来源。
- v2 MCP 是明确的风险项：配置 Schema 已定义（snake_case + servers 嵌套）但客户端与工具适配为源码 TODO，唯一实现是 v1——平台 v1 完整支持 MCP、v2 迁移把 MCP 列为待验证项，与 07 篇 §8「契约未冻结」同一处理策略（锁版本+定期同步+迁移前验证）。
- 工具名即权限 action 是三类资源的共同落点：内置（bash）、自定义（math_add）、MCP（github_create_issue）、skill 名（internal-docs）注册后全部进入同一开放权限命名空间（07 篇 §3.1），§6 链路图把「注册→materialize 过滤→ctx.ask 执行时检查」串成一条主线。
- v1/v2 的注册机制差异（Tool.define vs Tool.make、permission 模式 vs action+resource+effect、skills paths/urls vs string[]、MCP camelCase vs snake_case）全部收敛在 worker 侧翻译，控制面以「资源配置+权限规则」语义下发——与 07 篇 §11.5「只动 worker 侧」决策一致。
- dev 服务注入验证方式：md-docs dev 是 SPA（首页仅 `<div id="root">` 骨架），内容经 vite 虚拟模块注入，正确验证点是 curl `/@id/__x00__virtual:md-docs-content`（scanner.ts 的 docContent 来源），而非 curl 首页或文档路由。
- 编号顺延替换的两类陷阱：①连锁替换误伤——`（§5.6）→（§5.7）` 会二次改写刚由 `（§5.5）→（§5.6）` 生成的内容，必须先做高位编号替换（5.7→5.8）再做低位（5.6→5.7、5.5→5.6）；②引用形式不统一——「`，§5.7）`」前导逗号形式不匹配「`（§5.7）`」模式，需单独精确断言覆盖；本次用 `count==1` 精确断言 + 事后 grep 全量比对标题编号与引用目标双重校验。
- MCP 远程协议设计事实：opencode remote 类型自动探测（transports 数组先 StreamableHTTPClientTransport 失败再 SSEClientTransport，源码 index.ts:269-284），官方配置无协议选择字段——「协议选择」只能做平台层元数据（注册记录/展示/排障），不透传进 opencode 配置，冲突以实际探测为准回显。
- MCP 协议选择设计被回退（用户决策）：opencode 官方配置不支持协议参数、remote 自动探测（Streamable HTTP→SSE），平台层不做协议选择字段——「协议选择」是纯展示/排障事实而非平台能力，只保留 §5.1 一行事实性说明（平台不提供协议选择字段，连接协议由 opencode 自动探测）。
- 编号恢复与顺延同源陷阱：恢复编号时「（§5.8）→（§5.7）」刚生成的引用会被随后的「（§5.7）→（§5.6）」再次改写——高位→低位替换必须一次性用精确字符串按行处理（本次 3 处被误伤，靠事后引用分布与基线比对发现）；§8 差异表行含多个 §x 引用时须整体先行替换再处理其他引用。

## [12-产出物协议与文档库] 2026-08-06

- 新建 12 篇详设：产出物生命周期四环节「声明（json_schema）→ 归档（事件驱动）→ 版本演进（append 不可变）→ 文档库复用（列表/注入）」，验收基线 accepted_flag 为终态约束（03 篇 FR-04）。
- 关键事实依据锚点：09 §3.6 四端点 + 409 ARTIFACT_ACCEPTED_IMMUTABLE；09 §4.3 worker 消费表（message.part.delta file part / task.completed）；09 §5.4 拉取失败四步（2/4/8s×3、pending artifact、会话恢复重拉）；10 §8.2 产出物提交→system 消息；08 §6.1 artifacts/artifact_versions 表。
- 设计决策：非法声明拒绝归档回退普通消息；并发 append 用乐观锁 + sha256 幂等去重；同任务同 Agent 连续产出按规范化标题合并 append；版本无上限、验收基线不可撤销记为开放问题。
- 验证：md-docs build exit=0；grep 断言全过（mermaid 4 块）；dist 注入确认。

## 13-任务状态机与全生命周期（2026-08-06）

- 新建 13 篇详设：五态状态机（待开始/进行中/待验收/已完成/已归档）+ 5 个迁移动作（start/mark-pending-review/accept/reject/archive），每个迁移的动作、幂等、副作用逐项展开；验收基线 accepted_flag（12 篇 §7）、worker 实例绑定（08 §3.3 start 创建 / archive 回收）为核心联动。
- 关键事实依据锚点：03 篇 FR-01~08（五态、验收成员判定、主 Agent 不越权）；09 §3.4 六个任务端点 + §2.1 幂等（已处目标态返回 200 不重复产生 task_events）+ 409 TASK_INVALID_TRANSITION；09 §4.2 task.status_changed；10 §8.1 状态变更系统消息表；08 §6.1 tasks/task_events 表 + §6.3 状态机唯一事实源 + §7.4 三段式落库。
- 设计决策：状态枚举 pending/in_progress/pending_review/completed/archived；已完成→进行中为自动回退（验收后 Agent 追加版本，FR-04）非 REST 动作；归档后发消息/产出/团队调整全部禁止，GET 全保留；并发用 CAS 式状态更新 + task_events 幂等键。
- 验证：md-docs build exit=0；grep 断言全过（mermaid 2 块、accepted_flag×9、mark-pending-review×13、幂等×11）；dist JS bundle 注入确认（task-state-machine×1、标题×3、accepted_flag×19）。

## 14-Agent配置与虚拟团队模型（2026-08-06）

- 新建 14 篇详设：Agent 配置模型（三种来源 template/clone/custom + 五块配置项 FR-33~36/47/48 + 四类预置角色模板 FR-30）+ 任务虚拟团队（FR-02 组建与调整 / FR-08 主 Agent / FR-37 会话模型），回答「Agent 如何定义、如何加入任务协作」。
- 关键事实依据锚点：04 篇 FR-30~37/47/48（配置项全量）；03 篇 FR-02/08（团队与主 Agent 职责边界 4 条：协调权/推进/兜底/不越权验收）；09 §3.7 六端点 + §3.4 POST /tasks/:id/team + §3.5 /dm-channels；11 §7.3 资源×Agent 三落点（工具→permission 节+tools:false、技能→SKILL.md 可见集合+permission.skill deny、MCP→mcp 节+<server>_*）；07 §9.4 角色解析 v1 system 注入 vs v2 ctx.agent.transform、§10.3/10.4 v1 写文件+重启 vs v2 transform 热更新；13 §4.1 创建即入队获得会话、§4.2 启动私信主 Agent、§7.4 团队调整仅待开始/进行中；12 §8 doclib 注入（32KB 截断）。
- 设计决策：① 配置改动（prompt/effect/permissionScope/model）作用于后续会话即可 vs 文件类变更（SKILL.md/自定义工具）v1 需重启实例——两类机制在 §7.1 8 行生效表区分；② 「后续会话」语义 = 下一轮分派携带新配置，进行中会话不中断重放；③ 权限范围确认流闭环 = ctx.ask request → worker SSE 回流 → 控制面转成员确认 → 返回执行/拒绝（对齐 07 §5 权限链路第三步）；④ 会话 5 阶段（created/active/frozen/archived）与任务状态机联动；⑤ 模板只读 403 PERMISSION_AGENT_READONLY，克隆深拷贝 baseAgentId 血缘不联动。
- 验证：md-docs build exit=0（1.19s）；grep 断言全过（FR-47×11、available-models×5、permission×18、主 Agent×16、会话隔离×3）；mermaid 2 块（§5.2 flowchart + §8.1 sequenceDiagram）；422 行≥300；dist JS bundle 注入确认（agent-config-team-model×1、标题×2、frontmatter order:14 紧随 13 篇）；证据 .omo/evidence/agent-config-team-model.md。

## 15-数据模型细化（ER 图）（2026-08-06）

- 新建 15 篇详设：08 §6.1 表清单落库为字段级定义（20 表全量字段表 + mermaid erDiagram 完整关系图），承载 12/13/14 篇详设实体落库，09 篇端点字段对齐。
- 表数量口径校正：08 篇 §6.1 表格清单实为 20 张（含 audit_logs 预留），08/09 篇正文「21 表」为计数口径差异（audit_logs 是否计入）——文档以表格清单为准并在 §1 显式说明，避免与既有文档冲突。
- 主键策略统一为 VARCHAR(64)「域前缀+自增序号」（t_1/e_1024/s_1）：与 09/10/12/13/14 篇全部 string id 一致，序号单调性直接决定 SSE 事件 id/消息历史游标可排序可续拉（09 §4.1/10 §6）；类型映射表保留 BIGINT↔INTEGER 作为内部代理主键备选，不引入双主键复杂度。
- task_events 幂等设计的关键取舍：任务迁移防重由 tasks 乐观锁 CAS 承担（更新影响行数 0 → 幂等 200），**不设 (task_id, from_status, to_status) 唯一索引**——reject 会合法循环触发同型迁移（待验收→进行中可多次），唯一索引将误伤合法事件；任务书要求的「唯一索引防重复迁移」以「事件主键唯一 + CAS」语义满足并在 §6.2 显式说明理由。
- 外键策略：关系表声明 REFERENCES 但级联一律 ON DELETE RESTRICT——本版删除面极小（仅项目成员移除/自定义角色删除），删除路径由服务层显式编排，避免数据库隐式级联与 FR-05「归档不删内容」冲突。
- 本版无软删除列：删除语义以状态/标记替代（users.enabled、task_agents.removed_at、task_group_instances.removed_at、工具停用替代删除）——与 09 篇「任务/消息/产出物无 DELETE 端点」对齐。
- 验证：md-docs build exit=0；grep 断言全过（erDiagram×1、BIGINT×2、accepted_flag×8、task_agents×17、联合索引×1）；dist bundle + dev 虚拟模块双路注入确认（data-model-er×1）；证据 .omo/evidence/data-model-er.md。

## 16-内置Agent角色与提示词库（2026-08-06）

- 新建 16 篇详设：五类内置角色（产品经理/UI 设计/架构师/开发者/测试者）的完备提示词库，每角色给出「职责/权限/工作方式/协同方式」四方向可直接复制的系统提示词 + 默认配置映射表 + 协作矩阵行；UI 设计为 14 篇 §4.1 四类模板之外的新增角色。
- 关键事实依据锚点：14 §4.1 四类模板表（默认提示词定位/技能/工具集/权限范围/模型侧重）为结构源头；04 篇 FR-30（预置模板）/FR-33（提示词即时生效后续会话）；03 篇 FR-08（主 Agent 四职责：协调权/推进/兜底/不越权验收）；12 §2.1 三类产出物 + §8.2 doclib 注入格式；11 §2/§6 工具名即权限 action + effect 三态；15 §3.7 agents.prompt TEXT 落库。
- 核心设计决策：① 提示词声明行为边界（软约束）vs permission 配置做强约束（硬约束）——即使提示词被忽略，toolEffects/permissionScope 仍强制拦截，防绕过（11 §6 materialize + ctx.ask）；② 一致性要求：提示词权限块声明必须与 toolEffects 实际配置一致（测试者声明 bash ask 则配置侧必须 ask），否则撞权限墙或越权；③ 测试者验证结论不构成验收判定（FR-04/08），结论给成员判定；④ 五角色协同图：产品经理→UI→架构师→开发者→测试者→成员判定，虚线为主 Agent 协调动作；⑤ 占位符 {taskTitle}/{taskDescription}/{doclibIndex}/{teamMembers} 平台填充，失败时保留原文不报错。
- 验证：md-docs build exit=0；grep 断言全过（产品经理×28、UI 设计×20、架构师×20、开发者×37、测试者×24、职责×13、协同方式×10、mermaid×1、FR-08×24、FR-33×6、四方向提示词块×5）；dist bundle 注入确认（builtin-agent-prompts×1、标题×2、UI 设计×20、协同方式×10）；12→16 key 位置升序确认 order 连续；证据 .omo/evidence/builtin-agent-prompts.md。

## 2026-08-06：17 篇仓库权限与凭证机制 + 01 篇边界调整

- 17 篇定位：opencode 无内置 git 工具/无凭证机制（全 grep 0 命中），平台补三层——凭证管理（控制面 credentials/repo_grants 表）+ git 工具族（worker 注入 .opencode/tools/git.ts，工具名即权限 action）+ 注入清理（GIT_SSH_COMMAND / SSH_AUTH_SOCK / credential helper 三方式，shell.env 是官方注入点 shell.ts:416-426）。
- 核心链路：ask 确认（request→reply 事件流经 worker→控制面→前端 SSE→成员）→ 放行 → 取短时效凭证（60s~5min）→ 注入 env → 执行 → try/finally 用完即删；「总是允许」仅同会话 approved 列表，非永久授权。
- 双轨管控：内置工具族（工具级 effect）+ bash 裸 git 兜底（`git *: allow` arity 前缀，push 建议 `git push *: ask` 子命令模式收紧）。
- 01 篇边界调整：「不做仓库操作与发布流水线」→「不做 PR 合并与发布流水线」；仓库拉取/推送经本机制支持。
- 验证技巧：md-docs dev 服务注入验证走 `GET /@id/virtual:md-docs-content`（虚拟模块返回全部 markdown 原文），比请求 SPA 首页 HTML 可靠；dev 服务记得加 `--host 127.0.0.1` 并用 timeout 包裹启动命令防挂起；pkill -f 会匹配到自身 zsh 命令行导致 shell 挂起，清理进程用 pgrep -laf 先看 PID 再精确 kill。

## 2026-08-06 18-推进计划（分阶段实施）
- md-docs 内容注入端点：`/@id/__x00__virtual:md-docs-content`（key 为 `/docs/<rel>`），用于验证文档是否被 dev 服务收录。
- md-docs build 输出重定向到独立目录（`--out-dir`），不污染仓库；vite 大 chunk 警告（>500kB）为 mermaid 全量引入所致，非错误。
- 后台启动 md-docs dev 服务后需 `pkill -f md-docs` 清理；`pkill -f "md-docs --no-open --port XX"` 可能因参数被 shell 包装而匹配不到，直接 `pkill -f md-docs` 更可靠。
- 18 篇文档用「每阶段独立可功能性验收」措辞，验收点 M1~M5 逐阶段闭环、可回滚，「功能性验收」关键词需在 grep 断言中显式出现（已补入 §1.3 标题）。
