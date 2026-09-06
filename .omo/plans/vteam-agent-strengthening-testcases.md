# vteam-agent-strengthening 新增功能测试用例

> 版本: 1.0 | 基准: vteam-agent-strengthening (B线计划质量门禁 + A线ExecutionPolicy单通道) | 环境: docker compose (13000/13001) | 数据: seed-admin/Admin@123456, p_seed_2, commit 97a230e
> 覆盖: 30条 (P0 22 / P1 8) | 每条含前置、步骤、预期、后置、证据 | 可直接复制执行

## 环境与前置

| 项 | 值 |
|---|---|
| Web | http://localhost:13001 |
| API | http://localhost:13000/api/v1 |
| 账号 | seed-admin/Admin@123456 (admin), seed-member/Admin@123456 (member), admin/admin123 |
| 项目 | p_seed_2 文档协作平台 (空任务) |
| Token | `TOKEN=$(curl -s -X POST http://localhost:13000/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"seed-admin","password":"Admin@123456"}' \| python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('accessToken') or d.get('accessToken',''))")` |
| 任务创建 | `curl -X POST /api/v1/tasks -H "Authorization: Bearer $TOKEN" -d '{"name":"TC-xxx","projectId":"p_seed_2","executionMode":"plan"}'` → 记 `TASK_ID` + `ta_main` |
| 清理 | 每条新建独立任务/策略，互不干扰 |

---

## 一、B线：计划提交质量门禁

### TC-B1-001 缺acceptance 400（P0）
- **模块**: plan_submit schema
- **前置**: 已登录, 已创建PLAN任务T1
- **步骤**:
  1. 调 `POST /api/v1/platform-mcp` Header `x-worker-id: w_test`, Body `{"tool":"plan_submit","args":{"taskId":"T1","selfInstanceId":"ta_main","title":"t","tasks":[{"title":"t1","what":"实现登录","qa":"curl POST /api/v1/login 断言400"}]}}` （不传acceptance）
- **预期**: HTTP 400, 袋内 `code` 含 `VALIDATION` 或 `PLAN_STRUCTURE_INVALID`, `message` 精确含 `t1` + `acceptance` + `必填`
- **后置**: 无副作用
- **证据**: curl -i 日志

### TC-B1-002 缺qa 400（P0）
- **步骤**: 同上，仅传acceptance不传qa
- **预期**: 400 含 `qa` 必填

### TC-B1-003 正常提交200（P0）
- **步骤**: `acceptance:"访问/login提交错误密码返回401且含密码错误" qa:"curl POST /api/v1/login 缺少name断言400" references:"server/src/auth/auth.controller.ts"`
- **预期**: 200 `{"planId":"pl_...","status":"reviewing","taskCount":1}`

### TC-B2-001 qa=测试一下 空话打回（P0）
- **前置**: T1
- **步骤**: `qa:"测试一下"` 其余正常
- **预期**: 400 `code=PLAN_STRUCTURE_INVALID` `message`含 `纯空话` + `工具＋步骤＋预期结果` + 示例 `playwright`/`curl`

### TC-B2-002 qa=验证功能正常 无工具打回（P0）
- **步骤**: `qa:"验证功能正常可用"`
- **预期**: 400 含 `未包含任何可执行工具或结构化步骤`

### TC-B2-003 qa过短400（P0）
- **步骤**: `qa:"curl"`
- **预期**: 400 含 `过短（4字符）` + `工具＋步骤＋预期结果`

### TC-B2-004 qa含工具词放行（P0）
- **步骤**: `qa:"playwright 打开 /login 输入错误密码提交，断言出现密码错误提示"`
- **预期**: 200 通过

### TC-B2-005 qa含结构特征放行（P1）
- **步骤**: `qa:"git diff --stat 为空"` 或 `npm run build 无报错`
- **预期**: 200 通过

### TC-B3-001 acceptance=可用 过短400（P0）
- **步骤**: `acceptance:"可用"`
- **预期**: 400 含 `acceptance` + `过短`

### TC-B3-002 acceptance纯结论词400（P0）
- **步骤**: `acceptance:"正常可用完成"`
- **预期**: 400 含 `纯结论词`

### TC-B3-003 正常acceptance放行（P0）
- **步骤**: `acceptance:"构建日志出现 build finished 且退出码为0"`
- **预期**: 200

### TC-B4-001 references无路径仅警告（P1）
- **步骤**: `references:"需求文档第3节"` + 正常qa/acceptance
- **预期**: 200 + 返回体 `qualityWarnings` 数组长度1且含 `references` + `建议补充具体文件路径`

### TC-B4-002 references有路径无警告（P1）
- **步骤**: `references:"server/src/auth/auth.controller.ts"`
- **预期**: 200 + `qualityWarnings` 为空或无该条

### TC-B5-001 评审清单可见（P0）
- **前置**: 已提交计划P1，评审者为ta_x
- **步骤**: 浏览器：以评审者登录 → 进入任务 → 调 `plan_get` 或看 system prompt；或 `grep PLAN_REVIEW_CHECKLIST_INSTRUCTION server/src/chat/worker-dispatcher.ts`
- **预期**: 含 `【计划评审清单】只查四件事：1引用核查 2可起步 3一致性 4 QA可执行` + `四项全过approved/有阻塞rejected最多3个致命问题/风格不算驳回`

### TC-B5-002 rejected不带reason 400（P0）
- **步骤**: `plan_review {taskId:T1, selfInstanceId:ta_reviewer, verdict:"rejected"}` 不传reason
- **预期**: 400 `评审驳回必须填写reason`

### TC-B6-001 3次内可重提（P0）
- **前置**: 新建任务T2
- **步骤**: 循环3次：`plan_submit` → `plan_review rejected reason:"引用缺失"` → 查 `SELECT rejectCount FROM plans WHERE taskId=T2`
- **预期**: 3次均200，第3次后 `rejectCount=3`

### TC-B6-002 第4次409（P0）
- **步骤**: 紧接上条第4次 `plan_submit`
- **预期**: 409 `code=PLAN_REVIEW_ROUNDS_EXCEEDED` `message="已驳回3次，请向用户同步分歧点并请求人工裁决"`，且未进入quality guard

### TC-B6-003 approved后计数清零（P1）
- **前置**: 另起任务T3
- **步骤**: `submit→approved` → 再 `rejected` 新周期 → 查 `rejectCount`
- **预期**: 新周期 `rejectCount` 从1起，不叠加旧3

---

## 二、A线：ExecutionPolicy 策略体系

### TC-A1-001 创建custom只读策略201（P0）
- **前置**: admin Token
- **步骤**: `POST /api/v1/execution-policies` `{"name":"E2E-只读","type":"custom","config":{"permissions":{"read":"allow","write":"deny","bash":"ask"},"writePaths":[]}}`
- **预期**: 201 `id=ep_...` `type=custom`
- **后置**: 记 ep_readonly

### TC-A1-002 template只读403（P0）
- **步骤**: `PATCH /api/v1/execution-policies/<templateId>` 改名
- **预期**: 403 `template只读`

### TC-A1-003 创建custom开发策略201（P0）
- **步骤**: `{"name":"E2E-开发","type":"custom","config":{"permissions":{"read":"allow","write":"allow","bash":"ask"},"writePaths":["/data/vteam-worker/*"]}}`
- **预期**: 201 记 ep_dev

### TC-A1-004 非法permission 400（P1）
- **步骤**: `permissions:{"write":"yes"}`
- **预期**: 400 校验失败（枚举仅allow/ask/deny）

### TC-A1-005 克隆template（P1）
- **步骤**: Web 策略列表→点 `只读观察→克隆为自定义`
- **预期**: 生成 `type=custom` 新行，内容同源可编辑

### TC-A2-001 Agent绑定下拉可见并保存（P0）
- **前置**: 已有 ep_readonly/ep_dev
- **步骤**: Web `Agent管理→新建自定义Agent→执行策略下拉` → 应见 `E2E-只读/E2E-开发` → 选只读保存
- **预期**: 详情页显示 `当前绑定策略：E2E-只读`，`GET /api/v1/agents/{id}` 返回 `policyId=ep_readonly`

### TC-A2-002 不选回退默认最小权限（P1）
- **步骤**: 新建Agent不选策略保存
- **预期**: 详情显示 `默认最小权限`，`resolveExecutionConfig` 返回 `{"*":"ask"}`

### TC-A2-003 切换策略即时生效（P0）
- **步骤**: 编辑A2-001的Agent改绑 `E2E-开发` 保存 → 刷新
- **预期**: 显示变为 `E2E-开发`

### TC-A3-001 服务端解析policyId唯一来源（P0）
- **前置**: 代码审计
- **步骤**: `grep -r "permissionScope" server/src/platform-mcp/execution-policy.service.ts` → 0命中；`read execution-policy.service.ts` 含 `if (!agent.policyId) return {"*":"ask"}` 无 `if role`
- **预期**: 零角色硬编码，policyId唯一来源

### TC-A3-002 协议双端包含executionConfig（P0）
- **步骤**: `grep -q executionConfig worker/src/protocol/worker-protocol.ts && grep -q executionConfig server/src/workers/worker.client.ts`
- **预期**: 均命中

### TC-A3-003 翻译器确定性命名（P0）
- **步骤**: `read worker/src/resources/opencode-config-builder.ts` 调用 `buildOpencodeConfig({write:deny}, "ep_123")` 两次
- **预期**: 两次 `agentName` 相同为 `policy-<hash>`，无 `Math.random`

### TC-A3-004 零角色分支（P0）
- **步骤**: `grep -r "if.*role" worker/src/resources/opencode-config-builder.ts`
- **预期**: 0命中

---

## 三、E2E 物理拦截

### TC-E2-001 只读→写被物理deny（P0）
- **前置**: 新建任务TE2E，成员：`A只读`（绑ep_readonly，主Agent）+ 开发者各1，worker在线
- **步骤**: 群聊发 `帮我改代码文件，往 /data/vteam-worker/e2e.txt 写 hello`
- **预期**: 
  1. `docker logs aiagents-compose-worker --since 2m | grep executionConfig` 含 `write:deny` + `agentName=policy-...`
  2. 工具侧直接 `permission denied`（群聊可见），`cat /data/vteam-worker/e2e.txt` 无文件或内容无hello（非模型口头拒绝）

### TC-E2-002 切开发→同指令放行（P0）
- **步骤**: 同Agent改绑 `ep_dev`，同句重发
- **预期**: 日志 `write:allow`，`cat e2e.txt` 含 `hello`

### TC-E2-003 删除策略回退不崩（P1）
- **步骤**: `DELETE /api/v1/execution-policies/ep_readonly` → 触发已绑Agent的下次dispatch
- **预期**: 回退 `{"*":"ask"}`，无500

### TC-E2-004 五角色默认绑定（P0）
- **步骤**: `SELECT id,role,policyId FROM agents WHERE type='template'` 或重跑 `npm run seed` 后查
- **预期**: 5条均有 `policyId` 非空且幂等（产品/项目→文档协作, 架构→只读, 开发/测试→仓库开发）

---

## 执行与证据

- 每条独立任务/策略，互不干扰
- 每条产出 `curl -i` 日志 或 Playwright截图 + `SELECT` 结果 + `docker logs`（E2E）
- P0 22条全PASS才算通过
