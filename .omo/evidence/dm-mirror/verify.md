# dm-mirror — 群 @ 触发 DM 镜像验证

## ROOTCAUSE / 背景
群聊 @ agent 后，触发问题只落在群频道；agent 私聊 DM 无该问句，
DM 呈现断裂（Q 在群、A 在群，DM 无 Q 上下文）。createMessage 的
@ 解析→分派只面向群频道，无 DM 回写。

## 修复（server/src/chat/chat.service.ts，仅 createMessage @-trigger 路径）
- 群消息落库+广播后、FIFO 拦截前：dto 显式 @agent × dispatched trigger
  按 agentId 1:1 配对，每目标经 mirrorGroupMentionToDm 落一条镜像。
- 镜像内容逐字复制落库行 content/mentions（parts 原样，前端渲染一致），
  senderType=user + 同 senderId，附件三字段透传，taskId 置空（DM 无任务分区）。
- 私聊频道经 ensureMirrorPrivateChannel 复用 POST /dm-channels 幂等语义
  （已存在复用 / soft-delete 复活 / 缺失创建），+ channel/team 双 scope 广播。
- 不镜像：@all 展开（逐目标污染全员 DM）、无 @ 主回退、DM 来源、
  triggers 为空、非 user 发送。单目标失败仅日志，不阻塞群主路径/其他目标。

## 单元回归（chat.service.spec.ts，新增 dm-mirror describe ×5）
- 红：mirror 门短路（`false &&`，未动兄弟代码）→ 2 镜像用例 fail，
  3 不镜像用例 pass（符合预期：assert 缺席）。
- 绿：门恢复 → chat.service.spec.ts FULL 105/105；tsc --noEmit EXIT 0。

## LIVE（compose，server 重建：docker compose up -d --build server）
- 群 c_0000000001 发 @产品经理-1（taskId=t_0000000003）→ m_0000000064，
  triggers=[{a_product, ta_0000000013, s_0000000013, dispatched}]。
- DM c_0000000005（基线 2 行）5s 内新增 m_0000000065（user）：
  DB 行 content/mentions 与群行一致，taskId NULL；dm_user_rows=2（基线 1+镜像 1）。
- worker 回复 m_0000000066 落群（task-mode finalize 未动，符合 MUST-NOT-DO）。
- exactly-once：LIKE '%dm-mirror%' 在 DM 仅 m_0000000065 一行（db-exactly-once.txt）。
- 截图：dm-qa.png（私聊 Tab 镜像问句）、group-qa.png（群 Q&A 配对），均已目检。
- 未删改任何既有行；无 down -v（db Up 3h+ 连续）。

## 文件
group-send-response.json / dm-after-5s.txt / dm-after-80s.txt /
db-rows.txt / db-exactly-once.txt / dm-qa.png / group-qa.png
