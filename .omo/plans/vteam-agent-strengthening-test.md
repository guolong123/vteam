# vteam-agent-strengthening 严格执行测试计划

## 目标
以每条用例必有一张PNG截图的硬门槛，验证 vteam-agent-strengthening（B线计划质量门禁 + A线ExecutionPolicy单通道）全部38条用例，P0卡门，Fail-Fast。

## 环境
- Web http://localhost:13001  API http://localhost:13000/api/v1
- 账号 seed-admin/Admin@123456  项目 p_seed_2  docker compose已部署（init已施加2 migrations）
- 基准commit 97a230e

## 执行纪律（保证严格按计划执行）
- 单线程一事一证：一条TC → 执行 → PTY/Playwright截图 → 判定 → ledger落账，不批量
- Fail-Fast：任一P0失败立即停
- 双人复核：DoneClaim + AdversarialVerify.confirmed
- 零口头：无PNG=未执行
- 环境冻结：执行期间不build，不改seed
- 证据：.omo/evidence/vteam-agent-strengthening/<TC-ID>/screenshot.png + terminal.png（终端类）+ request.log + metadata.json

## Wave0 静态审计（5分钟）
- [x] W0-1 A1报告存在：docs/agent-platform/A1-opencode-channel-report.md 含“通道①”“热加载”“唯一选型” — evidence/W0-1/screenshot.png（PTY cat head）
- [x] W0-2 Prisma模型：grep model ExecutionPolicy + policyId — evidence/W0-2/screenshot.png
- [x] W0-3 Migration：ls migrations/20260824* + cat migration.sql 含reject_count/execution_policies — evidence/W0-3/screenshot.png

## Wave1 B线 计划质量门禁（40分钟，P0卡门）
- [x] B1-1 缺acceptance 400：plan_submit 不传acceptance → 400含t1+acceptance — curl -i PTY screenshot
- [x] B1-2 缺qa 400：不传qa → 400含qa
- [x] B1-3 正常通过：acceptance+qa完整 → 200 planId
- [x] B2-1 qa=测试一下 空话400：code=PLAN_STRUCTURE_INVALID含纯空话+工具＋步骤
- [x] B2-2 qa=验证功能正常 无工具400：含未包含任何可执行工具
- [x] B2-3 qa= curl 过短400：含过短（4字符）
- [x] B2-4 qa含工具词放行：playwright 打开 /login… → 200
- [x] B2-5 qa含结构特征放行：git diff --stat → 200
- [x] B3-1 acceptance=可用 过短400
- [x] B3-2 acceptance=正常可用完成 纯结论词400
- [x] B4-1 references无路径警告：references=需求文档第3节 → 200 + qualityWarnings含references
- [x] B4-2 references有路径无警告：server/src/auth/auth.controller.ts → 200无警告
- [x] B5-1 评审清单可见：plan_get system含引用核查/可起步/一致性/QA可执行 — Playwright截图
- [x] B5-2 rejected不带reason 400
- [x] B6-1 3次内可重提：submit→rejected×3 → rejectCount=3 — SQL截图
- [x] B6-2 第4次409：code=PLAN_REVIEW_ROUNDS_EXCEEDED
- [x] B6-3 approved后清零（P1）

## Wave2 A线 策略资源与翻译（30分钟）
- [x] A0-1 创建E2E-只读 201
- [x] A0-2 template只读403
- [x] A1-1 创建E2E-开发 201
- [x] A1-2 非法permission 400
- [x] A2-1 Agent绑定下拉：新建Agent→下拉可见E2E-只读/开发，保存后详情显示 — Playwright截图
- [x] A2-2 不选回退默认 — 截图
- [x] A9-1 resolveExecutionConfig：缺失回退{"*":"ask"} — npm test日志截图
- [x] A9-2 协议字段：grep executionConfig 双端 — PTY截图
- [x] A12-1 翻译器确定性：同config两次agentName相同 — 测试日志截图
- [x] A12-2 零角色硬编码：grep if.*role 0命中 — PTY截图

## Wave3 E2E 物理拦截（20分钟，P0必过）
- [x] E3-1 只读→写被deny：A只读绑E2E-只读，群聊发“往e2e.txt写hello” → worker日志write:deny + cat无文件 — 双图对照
- [x] E3-2 切开发→放行：改绑E2E-开发同指令 → 日志write:allow + cat有hello
- [x] E3-3 回退默认：删策略 → {"*":"ask"} 不崩
- [x] E3-4 五角色默认：SELECT policyId 5条均有

## 证据规范
- 每TC evidence/<TC-ID>/screenshot.png（Playwright） + terminal.png（PTY via web-terminal-visual-qa.mjs） + request.log
- 自检：test -s screenshot.png && file | grep PNG
- ledger.jsonl：{"event":"tc-executed","tc":"B2-1","verdict":"PASS","artifact":{"screenshot":"..."}}

## 截图保证
- 浏览器类：browser_take_screenshot scale:css
- 终端类：node script/qa/web-terminal-visual-qa.mjs --command "cat ..." --evidence-dir evidence/<TC>
- 一案一图，漏图=FAIL，AdversarialVerify验图才confirmed

## 准入准出
- 准入：docker ps 5 healthy + /health ok + seed-admin可登录 + HEAD冻结
- 准出：P0 23条全PASS + E3-1/E3-2双图对照，否则不算完成

## 执行
- 0-5m Wave0
- 5-45m Wave1
- 45-75m Wave2
- 75-95m Wave3
- 95-100m 复核 + ORCHESTRATION COMPLETE
