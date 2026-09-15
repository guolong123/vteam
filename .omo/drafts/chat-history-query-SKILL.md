---
name: chat-history-query
description: 查询任务群聊历史并准确定位最近消息：limit 取最早 N 条、sinceId 向后游标、按 id 取最大判最近，附单行 JSON 超长坑与应对。
version: 1.0.0
---

# chat-history-query（群聊历史查询）

用 `vteam_chat_history` 查询任务群聊历史并准确定位消息。出自学习模式实测（t_0000000001）。

## 工具与参数

- 工具：`vteam_chat_history`，只读。
- 参数：`taskId` / `teamId`（范围定位）、`limit`（条数，默认 100）、`sinceId`（游标）。
- 无 `order` / `sort` 参数，不可倒序。

## 语义（实测结论）

1. `limit` = 从最早开始取前 N 条，不是最近 N 条。
2. `sinceId` = 从指定 id 之后向后（时间正序）增量拉取，无法倒序取最近。
3. 「最近一条」判断口径：按返回消息 id 升序取最大 id。

## 坑与应对

- 返回是单行 JSON 数组；超 2000 字符时 `read` 只显示行首，超 64KB 时本地 `grep` 报 record exceeded，无法直接读末尾。
- 应对：sinceId 分页小步拉取；或缩小 limit 观察增量；不要编造看不到的内容，卡住就问。
