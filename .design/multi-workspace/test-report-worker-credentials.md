# 真实 Worker 安装 · Provider 凭据隔离/下发验证报告

> 目标：用**真实 worker 容器**（不是 mock/单测）验证 provider 凭证按工作空间隔离，
> 并且只下发到该空间的 worker。
> 环境：本地 compose 测试栈（server `13200` / web `13201` / 共享 worker token），
> worker 镜像由当前分支代码重新构建（含空间加入码能力）。
> 时间：2026-11-13。

## 1. 准备

1. 管理员创建两个工作空间：
   - A = `ws_0000000150`（`凭证明细A-<ts>`）
   - B = `ws_0000000151`（`凭证明细B-<ts>`）
2. 各自签发 worker 加入码：`POST /workspaces/:id/worker-token`。
3. 各自创建 provider 模型目录 + 凭据（API，写入加密存储）：
   - A：`anthropic` 模型 + key `sk-ant-A-<ts>-SECRET`
   - B：`anthropic` 模型 + key `sk-ant-B-<ts>-SECRET`
   - B 额外：`openai` 模型 + key `sk-openai-B-<ts>-SECRET`（验证「只在 B 出现的 provider」不会跑到 A）
4. 用镜像 `vteam-ws-worker` 启动两个**独立容器**，接同一 compose 网络：

```bash
docker run -d --name vteam-cred-a --network vteam-ws_vteam-net --init \
  -e X_WORKER_TOKEN=ws-test-worker-token \
  -e SERVER_URL=http://server:3000 \
  -e WORKER_ID=w_cred_a_<ts> \
  -e WORKSPACE_ID=ws_0000000150 \
  -e WORKER_JOIN_TOKEN=wjt_412ce93432... \
  -e OPENCODE_SERVER_PASSWORD=cred-test-serve-pass \
  -e OPENCODE_SERVE_PORT=4000 -e WORKER_MAX_INSTANCES=2 \
  -e WORK_DIR=/data/vteam-worker vteam-ws-worker
# vteam-cred-b 同理，WORKSPACE_ID=ws_0000000151 / 加入码 B / workerId=w_cred_b_<ts>
```

> 注：首次启动时发现旧 worker 镜像不含加入码上报，新空间注册被 403 拒绝；用当前分支代码重建
> worker 镜像后注册成功（说明加入码强制校验在真实安装链路上生效）。

## 2. 注册结果

```
[worker] 注册成功: workerId=w_cred_a_1794535855, heartbeatInterval=10000ms
[worker] 注册成功: workerId=w_cred_b_1794535855, heartbeatInterval=10000ms
```

## 3. 凭据落盘隔离（核心断言）

等待 worker 心跳拉取 `model-credentials` 命令后，直接读容器内凭据文件
`/root/.opencode-iso/data/opencode/auth.json`：

```json
// A 容器
{ "anthropic": { "type": "api", "key": "sk-ant-A-1794535855-SECRET" } }

// B 容器
{
  "anthropic": { "type": "api", "key": "sk-ant-B-1794535855-SECRET" },
  "openai":    { "type": "api", "key": "sk-openai-B-1794535855-SECRET" }
}
```

| 断言 | 结果 |
|---|---|
| 同一 provider 在两个空间使用不同 key | ✅ 各自只有自己的 key |
| A 的 key 是否出现在 B worker | ❌ 未出现 |
| B 的 key 是否出现在 A worker | ❌ 未出现 |
| 仅 B 配置的 `openai` 是否出现在 A worker | ❌ 未出现 |
| 服务端 DB 归属 | `ws_0000000151/anthropic`、`ws_0000000150/anthropic` 各 1 行（按空间独立） |

## 4. 变更下发（轮换）

A 空间把 anthropic key 换成 `sk-ant-A2-<ts>-ROTATED`（API 保存后立即广播），无需重启 worker：

```json
// A 容器（轮换后）
{ "anthropic": { "type": "api", "key": "sk-ant-A2-1794535855-ROTATED" } }
// B 容器：保持 B 的 key 与 openai 不变
```

worker 日志：
```
[config-reload] model-credentials（凭据注入）：热重载完成（POST /api/location/reload → 204）
[worker] credential store 已同步：新建=[无] 更新=[anthropic] 吊销删除=[无]
```

## 5. 吊销下发

A 空间 `DELETE /models/providers/anthropic/credentials` 后：

```json
// A 容器
{}
// B 容器：保留 anthropic + openai
```

worker 日志：
```
[worker] credential store 已同步：新建=[无] 更新=[无] 吊销删除=[anthropic]
```

## 6. Worker 列表/详情隔离

| 查询 | 结果 |
|---|---|
| A 空间 `GET /workers` | `[w_cred_a_<ts>]`（仅本空间节点） |
| B 空间 `GET /workers` | `[w_cred_b_<ts>]` |
| 默认空间 `GET /workers` | `[w_ws_test]`（不含 A/B 的测试节点） |
| A 用户 `GET /workers/w_cred_b_<ts>` | 404（跨空间按不存在处理） |

## 7. 结论与说明

- ✅ Provider 凭据按空间隔离存储、按空间下发：worker 的 opencode 凭据文件中只有本空间配置，
  轮换/吊销都只影响所属空间的 worker。
- ✅ 真实安装链路可用：worker 容器凭 `WORKSPACE_ID + WORKER_JOIN_TOKEN` 注册到目标空间，
  错误的/缺失的加入码会被服务端拒绝。
- 说明：测试环境没有真实上游模型目录（`integrations` 为空），worker 会提示
  “provider 已写入但 serve 未注册该 provider → 模型不可用”，这是**模型目录缺失**而非凭据隔离问题；
  `auth.json` 的凭据写入/更新/吊销均已逐条验证。
- 测试容器已清理（`docker rm -f vteam-cred-a vteam-cred-b`）；两个测试空间与凭据保留在测试库中。
- 证据截图：`.design/multi-workspace/shots/functional/22-凭证验证-空间B模型页.png`
  （B 空间模型页：anthropic/openai 均已配置，opencode 未配置；指纹脱敏展示）。
