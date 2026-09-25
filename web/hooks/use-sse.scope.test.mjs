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

function extractBlock(source, anchor) {
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, `${anchor} not found in use-sse.ts`);
  const braceOpen = source.indexOf("{", start);
  const bracketOpen = source.indexOf("[", start);
  // 数组常量（RECEIPT_ROUND_PLAN_PREFIXES）：截到配对 `] as const;`
  if (bracketOpen !== -1 && (braceOpen === -1 || bracketOpen < braceOpen)) {
    const end = source.indexOf("] as const;", bracketOpen);
    assert.notEqual(end, -1, "unbalanced brackets");
    return source.slice(start, end + "] as const;".length);
  }
  let depth = 0;
  for (let i = braceOpen; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

function extractMatchesScope(source) {
  return extractBlock(source, "export function matchesScope");
}

function loadMatchesScope() {
  // matchesScope 依赖同文件 helpers（isReceiptRoundPlanEvent + 前缀表）：一并提取进 sandbox，
  // 测的仍是 shipped 文件本身，非拷贝。
  const helpers = [
    extractBlock(src, "const TEAM_SCOPE_WHITELISTED_EVENTS"),
    extractBlock(src, "export const RECEIPT_ROUND_PLAN_PREFIXES"),
    extractBlock(src, "export function isReceiptRoundPlanEvent"),
    extractMatchesScope(src),
  ].join("\n");
  const { outputText } = ts.transpileModule(helpers, {
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

test("team: scope filters queue events by payload.teamId", () => {
  assert.equal(matchesScope(ev("team.queue.changed", { teamId: "tm_0000000001" }), "team:tm_0000000001"), true);
  assert.equal(matchesScope(ev("team.queue.changed", { teamId: "tm_OTHER" }), "team:tm_0000000001"), false);
  assert.equal(matchesScope(ev("team.queue.changed", {}), "team:tm_0000000001"), false);
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

// Todo 5 回执/轮次/计划事件 — 会话页（team:+channel:+global）与看板页（global+team:）须收到,缺席即红
const SESSION_SCOPE = "team:tm_0000000001,channel:c_0000000001,global";
const BOARD_SCOPE = "global,team:tm_0000000001";
const RECEIPT_ROUND_PLAN = [
  "receipt.acked",
  "receipt.expired",
  "round.complete",
  "round.stale",
  "plan.status.draft",
  "plan.status.reviewing",
  "plan.status.approved",
  "plan.status.rejected",
  "plan.status.executing",
  "plan.status.completed",
];

for (const type of RECEIPT_ROUND_PLAN) {
  test(`session page receives ${type} via team: segment`, () => {
    assert.equal(
      matchesScope(ev(type, { teamId: "tm_0000000001", channelId: "c_0000000001" }), SESSION_SCOPE),
      true,
    );
  });
  test(`board page receives ${type} via team: segment`, () => {
    assert.equal(
      matchesScope(ev(type, { teamId: "tm_0000000001", channelId: "c_0000000001" }), BOARD_SCOPE),
      true,
    );
  });
  test(`other-team ${type} is dropped on both pages (absence of leak)`, () => {
    assert.equal(
      matchesScope(ev(type, { teamId: "tm_OTHER", channelId: "c_OTHER" }), SESSION_SCOPE),
      false,
    );
    assert.equal(
      matchesScope(ev(type, { teamId: "tm_OTHER", channelId: "c_OTHER" }), BOARD_SCOPE),
      false,
    );
  });
}

test("session page receives receipt.acked via channel: segment", () => {
  assert.equal(
    matchesScope(ev("receipt.acked", { teamId: "tm_0000000001", channelId: "c_0000000001" }), "channel:c_0000000001"),
    true,
  );
  assert.equal(
    matchesScope(ev("receipt.acked", { teamId: "tm_0000000001", channelId: "c_0000000001" }), "channel:c_OTHER"),
    false,
  );
});

test("dot-naming: receipt/round/plan event names contain no underscores", () => {
  for (const type of RECEIPT_ROUND_PLAN) {
    assert.equal(type.includes("_"), false);
    assert.equal(type.includes("."), true);
  }
});
