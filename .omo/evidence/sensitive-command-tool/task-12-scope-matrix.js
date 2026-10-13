// Task 12 生产形状 scope 矩阵：从 shipped web/hooks/use-sse.ts 实时提取 matchesScope 打印真值表。
const fs = require("fs");
const path = require("path");

const webDir = path.join(__dirname, "..", "..", "..", "web");
const ts = require(path.join(webDir, "node_modules", "typescript"));
const src = fs.readFileSync(path.join(webDir, "hooks", "use-sse.ts"), "utf8");

function extractBlock(source, anchor) {
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error(`${anchor} not found`);
  const braceOpen = source.indexOf("{", start);
  const bracketOpen = source.indexOf("[", start);
  if (bracketOpen !== -1 && (braceOpen === -1 || bracketOpen < braceOpen)) {
    const end = source.indexOf("] as const;", bracketOpen);
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

const helpers = [
  extractBlock(src, "const TEAM_SCOPE_WHITELISTED_EVENTS"),
  extractBlock(src, "export const RECEIPT_ROUND_PLAN_PREFIXES"),
  extractBlock(src, "export function isReceiptRoundPlanEvent"),
  extractBlock(src, "export function matchesScope"),
].join("\n");

const { outputText } = ts.transpileModule(helpers, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const sandbox = { exports: {} };
new Function("sandbox", "exports", outputText)(sandbox, sandbox.exports);
const matchesScope = sandbox.exports.matchesScope;

const SESSION_SCOPE = "team:tm_0000000001,channel:c_0000000001,global";
const ev = (type, payload) => ({ id: "1", type, payload, timestamp: new Date().toISOString() });

const rows = [
  ["production", "agent.question", { taskId: "t_0000000001", teamId: "tm_0000000001" }, SESSION_SCOPE, true],
  ["production", "agent.question", { taskId: "t_0000000001", teamId: "tm_OTHER" }, SESSION_SCOPE, false],
  ["production (no teamId)", "agent.question", { taskId: "t_0000000001" }, SESSION_SCOPE, false],
  ["legacy fixture", "agent.question", { taskId: "team:tm_0000000001" }, SESSION_SCOPE, true],
  ["legacy bare id", "agent.question", { taskId: "tm_0000000001" }, SESSION_SCOPE, true],
  ["other team legacy", "agent.question", { taskId: "team:tm_OTHER" }, SESSION_SCOPE, false],
  ["reply/expire/ingress shape", "agent.question", { taskId: "team:tm_0000000001", teamId: "tm_0000000001", resolved: true }, SESSION_SCOPE, true],
  ["task-scope consumer", "agent.question", { taskId: "t_0000000001", teamId: "tm_0000000001" }, "task:t_0000000001", true],
  ["task-scope other task", "agent.question", { taskId: "t_OTHER", teamId: "tm_0000000001" }, "task:t_0000000001", false],
  ["task-scope ignores teamId (pre-existing)", "agent.question", { taskId: "t_0000000001", teamId: "tm_OTHER" }, "task:t_0000000001", true],
  ["queue whitelist", "team.queue.changed", { teamId: "tm_0000000001" }, SESSION_SCOPE, true],
  ["queue cross-team", "team.queue.changed", { teamId: "tm_OTHER" }, SESSION_SCOPE, false],
  ["chat passthrough", "chat.message.new", { message: { channelId: "c_0000000001" } }, SESSION_SCOPE, true],
  ["global branch", "task.status.changed", {}, "global", true],
];

let failed = 0;
console.log(
  ["case".padEnd(28), "event".padEnd(18), "scope".padEnd(40), "expected".padEnd(9), "actual"].join(" | "),
);
for (const [label, type, payload, scope, expected] of rows) {
  const actual = matchesScope(ev(type, payload), scope);
  if (actual !== expected) failed++;
  console.log(
    [
      label.padEnd(28),
      type.padEnd(18),
      scope.padEnd(40),
      String(expected).padEnd(9),
      String(actual),
    ].join(" | "),
  );
}
console.log(`\nrows=${rows.length} mismatched=${failed}`);
process.exit(failed === 0 ? 0 : 1);
