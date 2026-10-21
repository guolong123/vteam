# opencode v2 spike 复现物料（T4 / T5 / T6）

本目录是 [`../opencode-v2-spike-results.md`](../opencode-v2-spike-results.md) 的**可复用附属件**：
结论文档里引用的每一个最小样例都在这里，可以直接拷走复现。

## 最短复现路径（无凭据、无额度、不连外网）

```bash
cd docs/agent-platform/opencode-v2-spike-results
./repro.sh
```

`repro.sh` 会：

1. 起一个本地 OpenAI 兼容 mock provider（`mock-provider.mjs`），把**每一个到达模型的请求体落盘**；
2. 用 `mock-opencode.json` 建一个临时项目（自定义 provider + 两个带 `system` 的角色 agent）；
3. 起一个真的 `opencode serve`（v2），建会话、发 prompt、挂 SSE；
4. 断言 T4 的三条结论（角色提示是否进入最终模型请求 / `agents:[{name}]` 是否 no-op / `steer` 是否立即执行）
   与 T5 的两条结论（插件工具是否被模型直接调用、ToolContext 的键集合）；
5. 打印每条断言的 PASS/FAIL，并在退出时杀掉自己起的所有进程。

需要：真的 opencode 二进制（默认 `/Users/mac/.opencode/bin/opencode`）与 node。
可用 `OPENCODE_BIN=... ./repro.sh` 换二进制。

> **两个踩过的坑**（脚本里已经处理，重跑前请知悉）：
> - mock 端口被占时脚本会 **FATAL 退出**，不会静默产出空断言（一个残留的旧 mock 会让"请求体文件为空、断言全 false"）。
> - v2 的插件发现是**按 location 惰性触发**的：必须**先建会话/发 prompt**，插件的 `setup` 才会异步跑完；
>   立刻检查会得到假阴性。脚本里已加足等待。

## 文件说明

| 文件 | 作用 |
|---|---|
| `mock-provider.mjs` | 无凭据 OpenAI 兼容 mock provider。`__TOOL__:<name>:<json>` 触发一次工具调用，`__EXECUTE__:<js>` 触发一次 Code Mode 调用，其余回 `MOCK_OK`。把请求体按 JSONL 落盘到 `$MOCK_OUT`。 |
| `mock-opencode.json` | 配置文件样例：自定义 provider（指向 mock）+ 两个 `agents.<name>.system` 角色 agent。拷成项目的 `opencode.json` 即可用。 |
| `v2-tool-plugin.ts` | **最小 v2 工具插件**（≤30 行）。放到 `<project>/.opencode/plugins/` 下即被自动发现。演示 v2 工具注册的四个要点：JSON Schema 入参、`{content}` 返回值、`options:{codemode:false}` 才可被模型直接调用、ToolContext 的键集合。 |
| `dual-shape-plugin.ts` | **v1 + v2 双形态插件模块**。`export default { ...Plugin.define({id, setup}), async server() {...} }`：v1 调 `server()`，v2 调 `setup()` 并忽略 `server()`。已在 opencode 1.18.32 与 2.0.28 双侧实测。注意 v1 也会尝试调 `setup`，所以 v2 分支必须防呆。 |
| `evidence/` | 结论文档引用的**全部原始输出**（SSE 帧、最终模型请求体、类型原文、各轮矩阵）。 |

## 两个最容易踩的 v2 事实

1. **`.opencode/tools/*.ts` 的文件自动发现在 v2 已移除** —— 工具只能用插件注册（`ctx.tool.transform`）。
2. **插件工具默认只能经 Code Mode 调用** —— 模型必须写 JS 调 `execute` 才能用到它；
   要让模型直接 `tool_calls`，必须显式写 `options: { codemode: false }`。
