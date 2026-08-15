## [2026-08-10] E2E 验证发现的问题清单（192.168.10.78:13001）
### P1 严重 - 会话复用导致 Agent 回复内容错乱
- 现象：群聊/私聊复用同一 opencode session 后，回复聚合历史全部内容
  （[群聊历史消息] + <doclib> 注入 + 历史用户消息全部拼入 text）
- 证据：m_0000000103 新任务(e2e-doc)回复返回旧任务(bash测试)内容；
  m_0000000106 私聊问"介绍自己"回复却聚合了 bash 测试 + e2e-doc 声明 JSON
- 影响：用户无法获得正确回复；聊天界面冗余难读

### P2 严重 - Agent 创建的文档无法访问
- agent 创建的文件在 worker 容器 /tmp/opencode/ 下（已确认 3 个文件真实存在），浏览器不可达
- 手动提交 doc 产出物 fileRef 仅为路径占位：sha256=e3b0c442...(空内容哈希)，
  /uploads/english-mini-program-requirements.md 返回 404（文件未上传控制面，Phase 3 不真实拉取）
- 仅 text 类型产出物（内容在 DB）可正常访问

### P3 严重 - 产出物声明自动归档链路未生效
- 用户消息明确要求回复声明 {"type":"doc","title":"端到端文档测试","fileRef":...}，
  agent 回复文本中出现了该 JSON（m_0000000106），但产出物列表仍为空
- 归档依赖 worker 回流 payload.artifacts + server extractArtifacts(text)，链路未打通

### P4 严重 - 模型首字超时导致任务执行失败且无反馈
- [prompt-await] 等待首字超时 → worker abort 会话 → 消息永远停留在 processing 状态
- 用户界面无失败提示，误以为 agent 还在处理（m_0000000109 永久 processing）

### P5 中 - worker 心跳不稳定
- worker 心跳多次失败：fetch failed / HTTP 408 / HTTP 500
- server 端 Prisma 连接池超时（connection pool timeout, limit 33）
- 影响：worker 状态可能误判，任务调度可靠性下降

### P6 中 - 群聊回复文本拼接全局消息（用户需求①）
- [群聊历史消息] + <doclib> 直接拼进 AI 回复 text，显示难看
- 需维护全局消息自动注入，不拼接

### P7 低 - 产出物协议 + @机制需注入全局提示（用户需求②）
- agent 默认不按产出物协议回复，需显式要求；@机制说明应进全局 system prompt

### P8 低 - 侧边栏导航被 app-content 拦截（从任务页点击被 intercept pointer events）
