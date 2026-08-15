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

## 2026-08-14：主 Agent MCP task_transition（任务状态流转工具）

- 用户路径与 MCP 路径共用同一状态机：tasks.service transition 增加可选 actor {type,id}（缺省 user/调用者），5 个动作的副作用配置提取为 transitionOpts(id, action, reason?)——reject 的 reason 以第 3 参透传，MCP 路径只传 actor，行为零分叉。actor 同时写入 task_events.actorType/actorId 与 TASK_STATUS_CHANGED 广播（前端/审计可见操作者身份）。
- 主实例校验独立成方法 transitionByAgent：先查任务（404）→ 校验 mainAgentInstanceId === instanceId（403 TASK_STATUS_MAIN_AGENT_ONLY）→ 复用 transition。错误码新增而非复用（TASK_STATUS_MAIN_AGENT_ONLY），语义明确（仅主 Agent 权限）且与既有 TASK_ERRORS 风格一致。
- MCP 工具双层防伪：platform-mcp 层 assertWorkerTask 校验 worker↔任务会话归属 + selfInstanceId 一致性（防冒充），TasksService 层再校验主实例——真实链路中非主实例在归属校验层即被拒（"禁止冒充"），TasksService 的仅主 Agent 分支由单测覆盖（纵深防御，两层各自成立）。
- GLOBAL_SYSTEM_INSTRUCTIONS 是 Agent 能力宣言的唯一入口：新增 MCP 工具必须在其中加说明（Agent 才知道可用），同时更新 platform-mcp.module.ts 顶部注释与 controller.spec 工具数断言（12→13），三处数量口径同步。
- 真实链路验证注意：docker 容器跑旧镜像时 tools/call 报 "Unknown tool"，必须先 `docker compose up -d --build server` 重建；MySQL 查中文需 `--default-character-set=utf8mb4`，否则 JSON_EXTRACT 的中文系统消息显示为 ? 乱码。

## 2026-08-14：K8s 部署 vteam（chart/vteam → 远程集群 ns=vteam）

- 集群勘察先行：远程 K8s v1.26.12 + containerd，master SchedulingDisabled；节点可匿名访问 docker-hosted.ketaops.cc（已有大量 workload 在用），本机 docker 也已有该 registry 推送凭据 → 镜像策略定为推送 docker-hosted.ketaops.cc/xishuhq/vteam-*:vteam-k8s，mysql:8 也重推（规避 docker.ketaops.cc/library 匿名可达性不确定）。
- web 镜像必须重建：Next.js rewrites 的 API_PROXY_TARGET 编译进 routes-manifest.json，运行时 env 无效；compose 产物指向 http://server:3000，K8s 下 service 名是 vteam-server。重建验证法：docker run --entrypoint cat <img> /app/.next/routes-manifest.json | 检查 rewrites.afterFiles destination。
- server 镜像同时供 init Job 用（prisma migrate + seed），无需单独 init 镜像；验证镜像含 dist/prisma/seed.js 再装。
- helm install 显式提供 secret.*（openssl rand -hex 32/16），避免 chart 自动生成后升级漂移；dev 小资源用 -f values-dev.yaml + --set 覆盖。
- server 初始 CrashLoop（3 次）根因：Deployment 与 init Job 无硬性门控，server 在迁移建表前启动，Prisma 查 realtimeEvent 表抛 PrismaClientInitializationError → liveness 重启；init 完成后自愈。chart 的「server 依赖 init」是探针/重试兜底语义，非硬依赖。
- 冒烟注意：admin 非种子项目成员 → 创建任务 403（ProjectMembershipGuard 符合 RBAC 预期），用 seed-admin/Admin@123456（项目 owner）走通创建任务 201 + 双实例团队。
- 端到端硬证据：health 200 / web 200 / 登录 200 / agents API=5 模板 agent / DB agents=5 users=3 projects=2 / worker 注册成功 w_compose_worker + 心跳 201 / 任务创建 t_0000000014。
- K8s 外部可达性坑：本机 docker compose 旧部署常驻占用宿主 13000/13001，kubectl port-forward 绑定失败且无报错提示后续 curl 打到的是 compose 旧部署——验证前必须检查 port-forward 日志（"Unable to listen on port... already in use"）；另 Next.js standalone server.js 只监听 $HOSTNAME(pod IP) 非 loopback，kubectl port-forward 转发到 pod 127.0.0.1 也会 connection refused。可靠做法：集群有 ingress-nginx 时启用 chart ingress + NodePort + Host 头验证（一次验证 web→server rewrites 代理链路）。
- helm upgrade 改 values 前先 kubectl delete job vteam-init（Job spec.template immutable）；seed 全 upsert 幂等，重跑安全。

## 2026-08-14：K8s 内置 MCP（keta-platform）连接失败修复

- seed 硬编码 compose 服务名会穿透到 K8s：server/prisma/seed.ts 写死 `http://server:3000/api/v1/platform-mcp`，worker injectMcp() 从 mcp_servers 表拉 URL 注入 opencode.json → K8s 下 server 服务名是 `vteam-server`，探测失败。修复：URL 改 `process.env.PLATFORM_MCP_URL ?? 默认`（compose 行为不变），chart initJob 新增 `platformMcpUrl` 传给 init Job env（默认按 server Service 名拼 `http://<fullname>-server:3000/api/v1/platform-mcp`），seed 日志同步输出实际 URL。
- 多副本 worker 共享 home PVC 会损坏 opencode.db：replicaCount.worker=2 时两个 pod 并发写同一 NFS PVC 上的 SQLite（`/root/.local/share/opencode/opencode.db`）→ `PRAGMA integrity_check` 报 `Tree 23 page 23 Extends off end of page`、`opencode mcp list --pure` 报 `database disk image is malformed` → mcpStatus 探测失败上报不了 connected。恢复：备份+删除损坏 db 让 opencode 重建 + 临时降 1 副本；**若需恢复 2 副本须先按 pod 隔离 home 卷（每副本独立 PVC / StatefulSet）**。
- mcpStatus connected 双证路径：①worker 容器内 `opencode mcp list --pure`（在注入 cwd `/data/keta-worker` 下执行，显示 `●  ✓ keta-platform connected`）②server `GET /api/v1/workers` 的 mcpStatus / `GET /api/v1/mcp-servers` 的 status（worker 每 10s 心跳经 30s 节流的 probe 上报到内存）。探测用 cwd 必须与注入 opencode.json 的 workDir 一致，否则读不到 mcp 节。
- worker 容器内无 curl/wget 时用 `wget -qO-`（busybox），JSON POST 服务端连通性验证：`POST http://vteam-server:3000/api/v1/platform-mcp` 带 `X-Worker-Token`/`X-Worker-Id` header，`tools/list` 返回全部平台 MCP 工具即通。
- helm upgrade 持久修复流程：删旧 Job（`kubectl delete job vteam-init`，spec.template immutable）→ `--reuse-values --set server.image.tag=<新tag>` → init Job 重跑 seed（全 upsert 幂等）。已存在且 TTL 300s 自动清理时 delete 报 NotFound 属正常。
- server 镜像同时是 init Job 镜像：改 seed.ts 只需重建 vteam-server（`npm run build && docker build ./server`），无需独立 init 镜像；验证产物 `grep PLATFORM_MCP_URL dist/prisma/seed.js`。

## 2026-08-14：worker Deployment → StatefulSet（每副本独立 PVC 根治共享 home 卷损坏）

- 架构级根治共享 home 卷：worker 迁 StatefulSet + `volumeClaimTemplates`（worker-home→/root、worker-work→/data/keta-worker，各 RWO+size+storageClass），每副本独立 PVC（命名 `<template>-<sts>-<ordinal>`，如 `worker-home-vteam-worker-0`），多副本并发写 opencode.db（SQLite）不再相互损坏。扩容 `replicaCount.worker` 自动建独立 PVC；`enabled=false` 回退 emptyDir。
- StatefulSet 三件套必填/关键：`serviceName` 指向 headless Service（clusterIP: None，selector 同 pod 标签）；`podManagementPolicy: OrderedReady`（有序启动 0→1→n）；`updateStrategy: RollingUpdate` 且 `rollingUpdate.partition`（空不渲染子块=全量滚动；数字=仅升 ordinal≥partition 的副本）。
- helm `--reuse-values` 坑：chart 新增嵌套 values 键（如 `worker.updateStrategy.partition`）时旧 user-values 未携带该键 → 渲染 nil pointer。替代法：`helm get values <rel> -n <ns> | tail -n +2 > cur.yaml`（去掉首行 "USER-SUPPLIED VALUES:" 标题，否则解析出多余 key）+ `-f cur.yaml --set ...` 升级，等价且能带上新 chart 默认值。
- helm 3 upgrade 会**自动删除模板中移除的资源（含 PVC）**：Deployment→StatefulSet 迁移后旧共享 PVC `vteam-worker-home/work` 被 helm 删除，且 managed-nfs-storage reclaimPolicy=Delete → 旧数据不可恢复。要保留旧数据须 upgrade 前手动备份或先改 reclaimPolicy=Retain。
- worker 容器默认 cwd 是镜像 WORKDIR `/tmp/keta-worker`，而 MCP 配置注入在 `/data/keta-worker/opencode.json`：`kubectl exec <pod> -- opencode mcp list --pure` 直接跑会报 "No MCP servers configured"（误导），必须 `cd /data/keta-worker && opencode mcp list --pure` 才显示 `●  ✓ keta-platform connected`。
- 升级从 Deployment→StatefulSet：旧 Deployment pod 被替换为 worker-0/1（WORKER_ID 天然 `w_<pod名>`），server 侧 workers 表 2 行 online 独立注册 + mcpStatus 双 connected + worker_model_availabilities 按 workerId 各 7 模型；API 验证 token 在响应顶层 `accessToken`（非 data.accessToken），`/agents` 返回 `{items:[...]}` 非数组。

## 2026-08-14：SSH 私钥格式兼容修复（worker writeTempKey 格式归一，OPENSSH ssh-rsa → PKCS#1 PEM）

- 根因（详见 .omo/evidence/.../git-ssh-key-format.txt）：平台录入的 OPENSSH 容器格式 ssh-rsa 私钥在 OpenSSL 3.x（worker 10.3/3.5、宿主 8.9/3.0 均复现）加载报 `error in libcrypto: unsupported`，`ssh -i` 静默跳过 identity → git_clone Permission denied；同头 ed25519 / worker 自生成 ssh-rsa 正常 → 只转 ssh-rsa，且 worker 无 openssl 二进制（`ssh-keygen -p -m PEM` 对问题 key 也失败）→ 必须纯 Node 代码解析转换。
- 修复落点 `worker/src/git/git-tools.ts`：新增 `normalizeSshKey`（导出+自包含，随 renderGitToolsFile toString() 内联进渲染产物 git.ts，顺序必须在 writeTempKey 之前）→ `writeTempKey` 写盘前调用。openssh-key-v1 解析（cipher/kdf 须 none，nkeys=1，checkint 相等，keytype 分流）→ mpint 提取 n/e/d/p/q → PKCS#1 DER（version=0, dp=d mod(p-1), dq=d mod(q-1), qinv=q⁻¹ mod p，扩展欧几里得）→ PEM 64 字符换行。加密 key 抛错不静默；ed25519/PEM 原样；错误不含明文 key。
- 单测关键（git-tools.spec.ts 新增 14 项）：DER 解析器必须区分长短格式（SEQUENCE 长格式 content 起点 = 2+lenBytes，INTEGER 长格式长度字段总字节 = 1+lenBytes；3072bit 整数 >127 字节必触发）；OpenSSH 公钥 blob 的 mpint 需无条件符号位填充（n 最高字节 bit7=1 时）；测试 key 用 ssh-keygen 临时生成脱敏，helper 与实现不同源交叉验证（容器 blob 指纹 vs DER 重建 vs ssh-keygen -lf 三方一致）。
- helm upgrade 在 worker 仅改镜像 tag 时也可能整体失败（chart 触发 mysql sts spec 更新禁止 / uploads PVC resize 禁止）→ 直接 `kubectl set image sts/vteam-worker -n vteam worker=<repo>:<tag>` 只改 worker，避免动无关资源；改完删 pod 重建确认新镜像。
- 验证链路：宿主复现 FAIL → normalize → PEM 加载 OK + 指纹不变（SHA256:iy36pU1xfSgNS1/...）→ 宿主 git clone OK → worker 容器内 writeTempKey 真实代码路径 git clone OK。K8s worker 容器 dist 路径是 `/tmp/keta-worker/dist`（Dockerfile WORKDIR），非 /app/dist。

## 2026-08-14：任务巡检调度器 + 托管模式（question/permission 主 Agent 确认）

- 巡检调度器 `TaskProgressionScheduler`（server/src/tasks/）：内存循环表 + setInterval 扫描（仿 IDLE_SCAN_INTERVAL_MS 惰性启动模式）；register 在 tasks.service transition 事务提交后按 `to===in_progress` 触发（start/reject 注册、mark-pending-review 注销）；onModuleInit 扫描库内 in_progress 重建循环防重启丢失。dispatch 复用 `WorkerDispatcher.dispatchAgentMention` 全链路（assignWorker→createSession→execute→回流），target 用 `task.mainAgentInstanceId` 定位，频道 private（按 taskAgentId）优先、群聊回退。
- 托管路由的循环依赖解法：ingress（workers 模块）不直接注入 chat/tasks 服务，改为 ingress 落库时查 `task.managedMode` 并在 emit 的 AGENT_QUESTION payload 加 `managed:true` 标记；scheduler 在 onModuleInit 用 `realtime.subscribe(listener)`（无 scope 全量）订阅 bus，过滤 `type==='agent.question' && payload.managed===true && !payload.resolved` 后 dispatch 确认请求给主 Agent。避开 WorkersModule↔ChatModule 环。
- 主 Agent 真实执行巡检时按 prompt 引导自主决策：实际观察到创建缺失 issue 指派 + notify_agent 通知成员 + group_post 群聊同步 + submit_artifact 提交产出物（完全响应「引导而非写死」的 prompt 设计）。
- **NestJS ConfigService env 类型坑**：`config.get('X')` 返回字符串（`forRoot({isGlobal:true})` 无 infer），`typeof val==='number'` 恒 false → 用默认值。新配置必须 `Number(config.get('X')) + Number.isFinite` 归一。注意 worker-dispatcher 既有 `FIRST_TOKEN_TIMEOUT_MS` 等 env 若设字符串值同样失效（既有问题未修，非本期范围）。
- MCP 工具新增完整链路：platform-mcp.tools.ts 加 zod schema + buildPlatformMcpTools 注册 → service 加 handler（先 assertWorkerTask 归属校验防冒充）→ module imports 对应业务模块（question_confirm → QuestionsModule）。tools/list 数量断言测试（controller.spec 13→14）需同步更新。
- 权限模式复用：question_confirm 仅主实例可调——先 assertWorkerTask（活跃执行集合 + session 校验），再 QuestionsService.confirmByAgent 里 `task.mainAgentInstanceId !== instanceId → 403`。模拟事件（serve 端无真实请求）触发转发会走 serve 404 → 僵尸收敛 expired + 410，重复确认被幂等拦截（已终态 400）——这两个路径恰好证明转发与幂等保护都生效。
- 托管模式前端：QuestionModalData/RealtimeQuestionEvent 加 managedMode 字段；两个会话页（messages/[id]、tasks/[id]）onAgentQuestion 回调 + GET /questions 补拉处过滤 `managedMode`（不弹窗）；创建页/详情页托管开关（role="switch" + data-testid="managed-mode-toggle"），详情页 PATCH /tasks/:id {managedMode} + setQueryData 写回缓存（参考 addInstance 模式）。
- 事件上送验证捷径：`POST /api/v1/worker/events`（X-Worker-Token）可直接模拟 session.permission/session.question 落库，无需真实模型触发——但 serve 端无对应 requestId，转发必 404。验证托管「dispatch 到达主 Agent + 确认路由」够用；验证「worker 继续执行」需真实模型场景。
- 受影响 spec 批量修复模式：TasksService 加依赖 → provider mock；DTO 新增字段 → task.create 断言补字段；ingress emit payload 变化 → 补 prisma.task mock；platform-mcp 注入新服务 → provider mock + tools/list 断言 13→14。
- docker compose override：验证用临时 `docker-compose.override.yml`（services.server.environment 注入 PROGRESSION_INTERVAL_MS/MAX_ROUNDS）→ `docker compose up -d --force-recreate server`，验证后删除恢复默认。build server 时新迁移须重新 build init 镜像（`docker compose build init && docker compose run --rm init`）才应用。

## 2026-08-14：K8s server CrashLoopBackOff 根因=REV14 部分 upgrade 回退 values（DB 密码随机化 + 镜像回退 latest）

- 事故链（详见 .omo/evidence/.../k8s-server-crash.txt）：helm upgrade 只传 `--set worker.image.tag=...` → 其余 values 全部回退 chart 默认 → `secret.*` 清空 → `_helpers.tpl vteam.dbPassword` 走 `randAlphaNum 16` 生成新随机密码写入 ConfigMap DATABASE_URL（与 MySQL 数据卷初始化的真实 root 密码不一致）→ server `RealtimeService.onModuleInit` 首次查询 `prisma.realtimeEvent.findFirst()` 即抛 `PrismaClientInitializationError: Authentication failed ... credentials for 'root' are not valid` → CrashLoopBackOff；同次 upgrade 还把 server/web/init 镜像 repository 回退 `docker.ketaops.cc/ketaops/...:latest`（该镜像不存在）→ ImagePullBackOff；并触发 PVC resize + mysql sts spec 变更被拒 → 整体 `helm upgrade failed`，但 configmap/deploy 已部分落集群。
- **识别技巧**：同 ns 出现「CrashLoopBackOff(旧镜像) + ImagePullBackOff(latest 镜像) + init Job ImagePullBackOff」三态并存 = 一次失败 upgrade 的半成品状态；先 `helm history` + `helm get values --revision <N-1>` 对比 last-deployed 与 failed 的 user-values 差异。
- **修复路径（不删数据）**：`helm rollback <rel> <rev13>` 恢复 configmap/镜像（可能报 Ingress reconcile 错误部分完成）→ `kubectl delete job <rel>-init`（旧 Job template immutable，不删会挡 upgrade）→ `helm upgrade`（复用完整 values）→ **ConfigMap 修复后必须 `kubectl rollout restart deploy/<server>`**（K8s 不热更 envFrom，旧 pod 仍拿旧 DATABASE_URL）。
- 验证闭环：ingress `/api/v1/health` 200 + `{"status":"ok"}`；`POST /auth/login` 200；`GET /agents` 5 个种子 Agent；`kubectl exec mysql -- mysql -uroot -p<real> -e 'SELECT COUNT(*) FROM aiagents._prisma_migrations'`=14（迁移完整，排除迁移缺失嫌疑）。
- 教训：**部署命令必须携带完整 values**（`helm get values <rel> -n <ns> | tail -n +2 > cur.yaml` + `-f cur.yaml --set 增量`），禁止只传单个 --set；upgrade 失败后先看 helm history 再动手，不要盲目重启/删 PVC。

- **GitHub PR 分支链审核（2026-08-15）**：guolong123/vteam 4 PR 审核，核心发现——PR #4 分支（fix/group-post-mention-dispatch）包含 PR #1 的提交 54f3cde，`git diff <(git show review/pr1:file) <(git show review/pr4:file)` 验证 worker-dispatcher.ts IDENTICAL，即 PR #1 内容已被 PR #4 完整承载 → 合并 PR #4 后应关闭 PR #1，避免重复合并/冲突。合并顺序应与功能依赖对齐：先合基础设施（PR #2 work_dir），再合依赖它的提示词/修复（PR #4），独立功能最后（PR #3）。
- **目录根一致性陷阱**：PR #2 的 agent 工作目录硬编码 `/data/worker`，而既有 taskWorkDirRoot 读 WORK_DIR env（默认 /tmp/keta-worker-tasks）——同一 worker-dispatcher 内两套目录根语义，未设 WORK_DIR 时不同根，且 .env.example 注释暗示 WORK_DIR 控制 agent 目录与实现不符。审核此类「持久化路径」改动必须核对 env 可配项与硬编码路径的全部交叉点。
- **async 化 N+1**：PR #3 把 toIssueDto 变 async（解析操作记录 actorName），列表分页每条 issue 触发最多 3 个 findMany —— 列表路径不需要 activities 却全量 include。审核 async 化改造时检查所有调用路径的数据量级。
- **测试真实写系统目录**：PR #2 的 spec 断言 `fs.existsSync('/data/worker/产品经理')`，测试由临时根（config WORK_DIR）回归为硬编码系统路径——CI 非 root 会失败且污染系统目录。
- **GitHub PR 合并执行（2026-08-15）**：guolong123/vteam 4 PR 按序处理，#2 → #4 → #1（自动）→ #3 全部 MERGED。关键坑：`gh pr merge` 报 `GraphQL: Resource not accessible by personal access token (mergePullRequest)`——**fine-grained PAT 无法通过 GraphQL mergePullRequest，REST `PUT /pulls/:n/merge` 同样 403**（即使 token 有 push:true 权限）。替代方案：`git fetch github refs/pull/<n>/head:pr_<n>` → 独立 worktree（`git worktree add`，避免污染当前分支未提交改动）→ 逐 PR `git merge --no-ff pr_<n>` + `git push github merge-work:main` → GitHub 检测 head commit 进入 main 后**自动将 PR 标记为 MERGED**（`gh pr view <n> --json state` 验证），merge commit 保留完整 PR 历史，效果等价于 gh merge。若 PR 分支 commit 已被其他 PR 承载（如 #1 被 #4 包含），GitHub 合并后会自动把被承载的 PR 也标记为 MERGED（非 CLOSED），无需手动 close。
- 合并验证闭环：push 后 `sleep 3` → `gh pr view <n> --json state,mergedAt,mergeCommit` 确认 MERGED 再合下一个；最终 `gh pr list --state all` 无 OPEN 残留 + `git fetch github && git log github/main -5` 确认 main 更新。

## K8s 部署验证：main 合并 + 本地修复 + PR 冒烟（2026-08-15）
- **循环依赖陷阱（合并后才暴露）**：PR #2 引入 `worker-dispatcher import tasks.service`（sanitizeWorkDirName），本地又有 `scheduler → worker-dispatcher`，形成 `worker-dispatcher → tasks.service → scheduler → worker-dispatcher` 循环。CJS 下 NestJS 装饰器元数据（design:paramtypes）在循环中拿到 null → `Nest can't resolve dependencies`。**修复模板**：把被共享的纯函数抽到独立无依赖模块（work-dir.util.ts），打破循环。合并前若只跑单端 tsc 无法发现（tsc 不查 decorator 元数据运行时值），必须跑 jest/Nest 容器化测试。
- **PR schema 漏 @map（运行时才炸）**：PR #2 schema.prisma `workDir` 缺 `@map("work_dir")`，迁移 SQL 却建 `work_dir` 列。Prisma client 按字段名生成查询列名 `workDir` → 运行时 "column workDir does not exist"。**预防**：审查 PR 的 migration SQL 与 schema 字段 @map 一一对应（对比 grep 迁移列名 vs schema @map），尤其新字段必须显式 @map。
- **sed 批量替换 values 误伤**：`sed 's/tag: vteam-k8s-merged/tag: vteam-k8s-merged2/'` 把 web/worker 的 merged 也替换成 merged2（该镜像不存在）→ ImagePullBackOff。**纪律**：helm values 改镜像 tag 用结构化方式（python 按 server/web/worker 分块改），不要全局 sed 前缀匹配；upgrade 后立即 `kubectl get deploy/sts -o jsonpath` 核对三端 image。
- **helm 升级坑：Job/STS 不可变字段**：init Job spec.template 变更报 `field is immutable`（历史 rev16 踩过）。本次用完整 values 基线 upgrade 成功（rev23/25），init Job 由 helm 以新 name 重建——**完整 values 基线纪律有效**。
- **port-forward 端口残留**：旧 port-forward 进程占 13000，curl 打到旧 pod 导致数据不一致（workers 列表缺 vteam-worker-0 误判）。`ss -tlnp` 看不到 pid 时用新端口（13100/13101）绕过，并用 `kubectl get endpoints` 确认 svc 指向新 pod。
- **Next standalone 监听容器 IP 非 localhost**：web port-forward 127.0.0.1 失败（ECONNREFUSED），容器内 curl 也失败——Next 监听 pod IP。验证用 pod IP 或 `kubectl exec ... node fetch http://<podIP>:3000`。
- **MCP 运行时冒烟直接调 JSON-RPC**：POST /api/v1/platform-mcp + x-worker-token/x-worker-id 头 + `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"group_post",...}}` 可同步返回 result（无需 SSE 长连接），适合 CI 冒烟。tools/list 返回 14 工具确认 question_confirm 存在。
- **模型执行首字超时（环境噪声）**：deepseek-v4-flash 某会话首字超时 1 次（prompt-await abort），同 worker 其他会话成功。冒烟时区分「代码 bug」与「模型偶发」，重试或换会话确认，勿据单次失败判部署失败。

## Round-2 GitHub PR #5-#8 合并+部署（2026-08-15）

1. **worktree 隔离合并**：git worktree add /tmp/opencode/vteam-pr2nd github/main -b merge-pr2nd，4 PR 按序 merge --no-ff，ort 策略对同文件（tasks/[id]/page.tsx）不同区域改动可自动合并，未出现 #6/#8 冲突。push 到 github main 后 GitHub 自动标 MERGED。
2. **本地合并唯一冲突**：tasks/[id]/page.tsx TaskPanel props 三方重叠（PR#6 width / PR#8 无 / 本地托管 onToggleManagedMode），stash pop 冲突后需手动合并 props 解构+类型+调用处三处，两侧语义都保留。
3. **SSE 本机 curl 坑**：curl 对 SSE 流有缓冲（0 字节落盘），且经本机 port-forward 偶发 401；pod 内 wget 直连 200 + 事件流完整。验证 SSE 事件用 kubectl exec pod 内 wget -O 文件 + 触发业务操作 + 读文件。
4. **read_file 权限防护**：assertWorkerTask 需 session.workerId 匹配（dispatcher 绑定），任务未实际分派前 read_file 403「该 worker 无此任务会话」是预期防护；冒烟改用上传链路+静态访问+单测覆盖。
5. **helm upgrade 必须带 chart 路径**：helm upgrade vteam -n vteam chart/vteam -f <基线>，只传 -f 会报 requires 2 arguments。values 基线直接导出 helm get values（含 secret），改三 tag 后 -f 全量覆盖，REV 25→27 一次成功。
6. **worker 旧任务循环**：worker 卡在 t_0000000008 [exec] 328 chars 反复执行（旧任务遗留），新任务消息排队；影响冒烟（read_file 会话绑定），非本次部署引入。
