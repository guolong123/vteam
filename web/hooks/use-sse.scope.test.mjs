/**
 * matchesScope 回归:team: 分支须放行 `team:<id>` 前缀的 taskId。
 *
 * 背景:dispatcher 经 toExecutionScope(null, teamId) 广播 team loading,
 * payload.taskId 恒为 `team:<teamId>` scope 串(见 server worker-dispatcher.ts);
 * 会话页只订阅 `team:${teamId},channel:...,global`,故 team: 分支必须同时接受
 * 裸 id 与 `team:${id}` 两种 taskId 形状,否则 DM tab spinner/底部 loading 提示永不出现。
 *
 * 运行:web/ 下 `node --test hooks/use-sse.scope.test.mjs`(零新依赖:
 * 仅 node 内置 test/assert + web devDependencies 自带的 typescript 做类型剥离)。
 * 被测函数从 hooks/use-sse.ts 源码实时提取并转译,测的是 shipped 文件本身,非拷贝。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// web devDependencies 自带,非新增
const ts = require("typescript");

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "use-sse.ts"), "utf8");

function extractMatchesScope(source) {
  const anchor = "export function matchesScope";
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, "matchesScope not found in use-sse.ts");
  const braceOpen = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceOpen; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in matchesScope");
}

function loadMatchesScope() {
  const fnSrc = extractMatchesScope(src);
  const { outputText } = ts.transpileModule(fnSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const sandbox = { exports: {} };
  new Function("sandbox", "exports", outputText)(sandbox, sandbox.exports);
  return sandbox.exports.matchesScope;
}

const matchesScope = loadMatchesScope();
const ev = (type, payload) => ({ id: "1", type, payload, timestamp: new Date().toISOString() });

// team: 分支 — agent.loading / error / status / question 须接受 `team:<id>` 前缀
test("team: scope passes agent.loading with team:-prefixed taskId", () => {
  assert.equal(matchesScope(ev("agent.loading", { taskId: "team:tm_0000000001" }), "team:tm_0000000001"), true);
});

test("team: scope still passes agent.loading with bare taskId", () => {
  assert.equal(matchesScope(ev("agent.loading", { taskId: "tm_0000000001" }), "team:tm_0000000001"), true);
});

test("team: scope drops agent.loading for another team", () => {
  assert.equal(matchesScope(ev("agent.loading", { taskId: "team:tm_OTHER" }), "team:tm_0000000001"), false);
});

for (const type of ["agent.error", "agent.status", "agent.question"]) {
  test(`team: scope passes ${type} with team:-prefixed taskId`, () => {
    assert.equal(matchesScope(ev(type, { taskId: "team:tm_0000000001" }), "team:tm_0000000001"), true);
  });
}

// task: 分支审计 — toExecutionScope(taskId) 返回裸 taskId,故裸匹配正确,无需改
test("task: scope passes agent.loading with bare taskId (legacy task-mode shape)", () => {
  assert.equal(matchesScope(ev("agent.loading", { taskId: "t_0000000001" }), "task:t_0000000001"), true);
});

// channel: 分支审计 — 按 message.channelId 匹配,与 taskId 前缀无关,无需改
test("channel: scope passes chat.message.new for the subscribed channel", () => {
  const payload = { message: { channelId: "c_0000000001" } };
  assert.equal(matchesScope(ev("chat.message.new", payload), "channel:c_0000000001"), true);
  assert.equal(matchesScope(ev("chat.message.new", payload), "channel:c_OTHER"), false);
});

// global 分支审计 — task.status.changed 全局广播,无需改
test("global scope passes task.status.changed", () => {
  assert.equal(matchesScope(ev("task.status.changed", {}), "global"), true);
});
