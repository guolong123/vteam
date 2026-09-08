# 新会话任务：两个线上 UI/链路问题（team-free-chat 后续）

> 使用方式：新开会话，把下面"任务正文"整段粘贴给助手。仓库与部署均已就绪。

---

## 任务正文（从这里开始复制）

在仓库 `/Users/mac/01work/git-project/vteam` 里修下面两个**已上线验证过复现**的问题。一次解决一个，先做问题一，确认后再做问题二。修完每个问题都要：相关单测绿 + `tsc` 干净 + 线上实测证据 + 测试数据清干净。**不要 push；是否 commit 完工后问我。**

### 全局背景（必读）

- 项目：vteam 虚拟团队协作平台。`server/`（NestJS+Prisma+MySQL，API `:13000`）、`web/`（Next.js，`:13001`）、`worker/`（opencode 执行节点）。`docker compose` 项目名 `aiagents-*`，DB 在 compose 网络内（宿主机直连用 `mysql://root:aiagents-root@192.168.97.2:3306/aiagents`，localhost:3306 不通）。
- 主线计划 team-free-chat 已完工（11/11），其后有 8 个线上 incident 修复 commits，最新的在 HEAD 附近（`git log --oneline -10` 自查）。**注意：工作区有未提交改动**（`git status` 先看）：`server/src/workers/worker-event.ingress.ts` + 其 spec 里有"团队流式 delta 改落成员私聊频道"的未提交修复——动它之前先读懂，别覆盖，别重复修。
- 账号：`seed-admin/Admin@123456`（项目 owner、团队 owner）、`admin/admin123`（平台管理员，无项目身份）、`seed-member/Admin@123456`（普通成员）。种子团队 `tm_0000000001`，种子项目 `p_seed_1`（任务数保持 6 个，动了要恢复）。
- 测试纪律：只用新建的测试团队/消息做验证；清场按外键安全顺序删（messages→sessions→task_group_instances→team_queues→team_user_members→chat_channels→team_members→(task_events→task_agents→tasks)→teams），删完 `GET /teams/:id` 必须 404；不要碰种子数据和别人的团队；不要 `down -v`、不要 prune。
- 设计 token 集中在 `web/src/theme/tokens.ts`，禁止散落魔法值；后端 catch 必须打日志（禁止空 catch）。

### 问题一：深色模式下 @ 用户的高亮消息样式错乱（有截图证据）

现象：深色模式群聊里，一条 @ 了当前用户（带 `@你` 徽标）的 Agent 消息，正文渲染成一个**巨大的白色底框**（浅色底 + 蓝色描边），里面像是个状态图（`idle/active/running/accept/archive/mark-pending-review` 等代码 chips），跟深色 UI 严重割裂。

已排查到的线索（接着查，不要从零开始）：
- 聊天正文走 `web/src/components/ui/markdown.tsx` 的 `Markdown`（`.md-render` 作用域样式）：`pre` 是硬编码深色 `#0F172A`，`code` 行内走 `var(--color-neutral-*)`——**这个文件本身大概率不是白框来源**，先排除再定罪。
- `MermaidBlock` 只活在 `web/src/features/docs-site/`（docs 站），聊天链路没引用它——如果白框真是 mermaid 渲染的，去找聊天页是否有人偷偷复用了 docs 的 markdown 渲染器。
- 聊天消息外壳在 `web/src/components/chat/`（`msg-parts.tsx` 用 `ChatBubble` + `Markdown`；`chat-bubble.tsx` 管气泡样式）。**重点怀疑对象**：@ 高亮分支（带 `@你` 徽标的那层容器样式，可能是写死的浅色底 + 蓝边）。
- 主题系统：`web/src/theme/tokens.ts` + CSS 变量，深浅两套都要 work，禁止只 hardcode 深色。

验收：深色模式真机截图——@ 高亮消息为深色面、文字 chipes 对比度合格、无白色闪框；浅色模式外观不变（截图或 token 映射说理）；`web/` 下 `tsc --noEmit` 干净。

### 问题二：用户发的图片到不了模型（有线上实证）

现象：用户在群里发"文字+截图"，Agent 回复"我看不到图片内容"。Agent 原话：附件 URL（如 `/uploads/85d63e9f-….png`，文件名/格式都能看到）可达，但图片文件不在它的工作区（`/data/vteam-worker/`），读不到像素；即使模型支持视觉也白搭。

已排查到的链路（接着查）：
- 上传：`POST /uploads` → `server/uploads/`（UUID 文件名，10MB 白名单，png/jpg 在列）→ 返回 `{url: '/uploads/<file>', name, size, ext}`；前端 `MessageAttachment` 随消息提交；消息行落 `attachmentUrl/Name/Type`。
- 分派：触发 prompt 目前**只带文本**，图片引用没进执行上下文——这就是断点。
- 现成零件（复用，别重造）：`FileStorageService.readUploadedFile`（读 uploads）、MCP `read_file`（但它是任务绑定且偏文本/归档用途）、`saveBufferFile`、`normalizeFileRef`、agent→群的 `group_post fileRef` 反向链路（现成的，不用动）。
- 关键待确认点（必须先证实再写代码）：worker 的 opencode 驱动（`worker/src`，找 V1Driver/prompt parts 组装）支不支持图片输入 parts？server 有没有办法把字节送进 agent 工作区（先验证 volume 挂载关系，不要假设）？uploads 静态路由要不要鉴权（不要为修功能开匿名口子）？
- 约束：图片限大小（定个 cap 并写进代码注释）；非图片附件行为不变；纯文本分派回归单测全绿。

验收：你自己生成一张自描述测试图（大字如 `HELLO-42`，PIL/convert 任选）→ 发"文字+图"到测试团 → Agent 回复里**引用出图上的字**（证明真看见了）。然后删干净（消息/团队按顺序清，`/uploads` 下的测试文件一并删）。

---

## （复制到此结束）

附带说明（给接手助手的上下文，不用照做，仅供参考）：
- 上游已验证可用的探针：`POST /api/v1/auth/login` 拿 token；`GET /api/v1/channels?teamId=` 看频道；`POST /api/v1/channels/:id/messages` 发消息（`{text, mentions}`，图片消息看 message-input 的 attachment 字段怎么随包）；SSE `GET /api/v1/events?scope=all&token=` 可实抓帧。
- 注意：两个问题互相独立，严禁为了"顺手"互相碰对方的文件。
