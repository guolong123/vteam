/**
 * guard 插件渲染器（vteam-role-behavior-enforcement Todo 18）。
 *
 * 纯构造器 `renderRoleGuardPlugin(): string` —— 生成自包含的 opencode 插件模块
 * `<workDir>/.opencode/plugin/vteam-role-guard.ts`（写入 + `plugin` 数组注册由
 * `resources/injector.ts` 负责，本模块不碰磁盘）。
 *
 * 渲染选择（已记录决策）：**render-inline 快照，不用 `toString()`**——
 * `role-guard/policy.ts` 的判定辅助函数（`isPlainObject`/`hasOwn`/`isEditDenied`/
 * `extractEditTargets` 等）是模块私有没有导出，`toString()` 只能拿到 5 个导出函数的
 * 外壳，仍需手写内部快照（半同步比全快照更易悄悄漂移）。此处是与 `policy.ts`
 * 逐行对齐的手工快照，二者等价性由 `role-guard-plugin.spec.ts` 的 parity 矩阵锁定
 *（`policy.ts` 任一分支改动未同步快照即红）。`git-tools.ts` 的 `toString()` 模式
 * 仅适用于被内联函数全部导出的模块，此处不适用。
 *
 * 发射产物要点（spike 实测依据见 `.omo/evidence/role-enforcement/guard-plugin-spike.md`）：
 * - 插件工厂签名 `export const VteamRoleGuard = async (ctx) => ({ "tool.execute.before": … })`，
 *   hook 输入 `{ tool, sessionID, callID }`、输出 `{ args }`（opencode 1.18.30 文档签名）；
 * - `deny → throw new Error(<纠正文案>)`（opencode 阻断调用并向模型展示该消息）；
 * - `<workDir>` 定位三锚点：① 插件自身注入位置（`import.meta.url` →
 *   `<workDir>/.opencode/plugin/` 上两级）；② 工厂 `ctx.directory` 向上 findUp
 *  （`tasks/<id>` 执行目录向上爬到含 `roles.json`/`opencode.json` 的根）；③ 回退
 *   `ctx.directory || process.cwd()`。显式 `plugin` 数组条目使加载不依赖
 *   `.opencode/plugins/`（复数）原生发现目录；
 * - `roles.json`/session 缺失或解析失败 → pass-through（与 `policy.ts` 分支 1/2 一致，
 *   绝不 fail-closed；Todo 19 的 writer 缺席时同样放行）；
 * - session 文件名经 `sanitizeSessionId` 消毒（`session-policy-map.ts` 同正则，防路径穿越）。
 *
 * 约束（worker 独立进程铁律）：本模块无 IO、无 fetch、不 import opencode/server 代码；
 * 发射产物仅 import `node:` 内置模块。
 */

const DECISION_BEGIN = '// <vteam-role-guard:decision-begin>';
const DECISION_END = '// <vteam-role-guard:decision-end>';

/** 判定块起止标记（spec 提取该块做 parity/hook 仿真；对外导出供 spec 共用）。 */
export const DECISION_MARKERS = { begin: DECISION_BEGIN, end: DECISION_END } as const;

/**
 * 渲染 guard 插件文件全文。
 *
 * 纯函数：同一次提交内输出字节稳定（injector 幂等断言依赖此性质）。
 */
export function renderRoleGuardPlugin(): string {
  return `/**
 * vteam-role-guard —— 角色越权守卫插件（worker ResourceInjector 自动生成，勿手改）。
 *
 * 加载：\`opencode.json\` \`plugin\` 数组显式条目 \`./.opencode/plugin/vteam-role-guard.ts\`
 * （不依赖 \`.opencode/plugins/\` 原生发现目录；\`--pure\` 下不加载，见降级表）。
 * 数据源：\`<workDir>/.vteam-role-guard/roles.json\`（{ enabled, roles }）+
 * \`sessions/<sessionID>.json\`（{ agent, dir }，Todo 19 写入；缺席即 pass-through）。
 * 判定逻辑为 \`worker/src/role-guard/policy.ts\` 的内联快照（分支优先级与之一致，
 * 等价性由 \`role-guard-plugin.spec.ts\` parity 矩阵锁定）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD_DIR_NAME = ".vteam-role-guard";
const ROLES_FILE_NAME = "roles.json";
const SESSIONS_DIR_NAME = "sessions";
const UNSAFE_SESSION_CHARS = /[^A-Za-z0-9._-]/g;

${DECISION_BEGIN}
const READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "lsp",
  "webfetch",
  "websearch",
  "list",
  "todowrite",
  "todoread",
]);
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "patch",
  "multiedit",
]);
const TASK_TOOLS = new Set(["task", "execute"]);
/**
 * 主实例专属（server-gated）MCP 工具：判定权在 platform-mcp 服务端
 * （task.mainAgentInstanceId / team.mainAgentMemberId），guard 一律放行、不参与。
 * 与 server \`ROLE_SERVER_GATED_TOOLS\`（agent.constants.ts）同值，两侧一致性由
 * parity spec + e2e 锁定。
 */
const SERVER_GATED_TOOLS = new Set([
  "vteam_task_transition",
  "vteam_question_confirm",
  "vteam_task_create",
  "vteam_plan_mode",
  "vteam_team_add_member",
]);
const BUILTIN_PASSTHROUGH = new Set(["question", "plan_exit", "skill"]);

function evaluateToolCall(params) {
  const rolesDoc = params.rolesDoc;
  const session = params.session;
  const tool = params.tool;
  const args = params.args;
  if (!isPlainObject(rolesDoc) || rolesDoc.enabled !== true) {
    return { action: "allow" };
  }
  const roles = rolesDoc.roles;
  if (!isPlainObject(roles)) {
    return { action: "allow" };
  }
  const agent = isPlainObject(session) ? session.agent : undefined;
  if (typeof agent !== "string" || agent.length === 0 || !hasOwn(roles, agent)) {
    return { action: "allow" };
  }
  const role = roles[agent];
  if (!isPlainObject(role) || !isPlainObject(role.permission) || !isPlainObject(role.tools)) {
    return denyWithCorrection(agent, tool, readCorrection(role));
  }
  const policy = role;
  if (typeof tool !== "string" || tool.length === 0) {
    return { action: "allow" };
  }
  if (READ_TOOLS.has(tool)) {
    return { action: "allow" };
  }
  if (EDIT_TOOLS.has(tool)) {
    const targets = extractEditTargets(tool, args);
    if (targets.length === 0) {
      return { action: "allow" };
    }
    const editMap = isPlainObject(policy.permission.edit) ? policy.permission.edit : null;
    if (!editMap) {
      return { action: "allow" };
    }
    const denied = targets.some(function (target) { return isEditDenied(target, editMap); });
    return denied ? denyWithCorrection(agent, tool, policy.correction) : { action: "allow" };
  }
  if (tool === "bash") {
    const command = isPlainObject(args) ? args.command : undefined;
    if (typeof command !== "string" || command.length === 0) {
      return { action: "allow" };
    }
    const rawPatterns = Array.isArray(policy.bashDeny) ? policy.bashDeny : [];
    const patterns = rawPatterns.filter(function (p) { return typeof p === "string"; });
    return matchesBashDeny(command, patterns)
      ? denyWithCorrection(agent, tool, policy.correction)
      : { action: "allow" };
  }
  if (tool === "task" && agent === "vteam-plan" && isPlainObject(args) && args.subagent_type === "vteam-plan") {
    return { action: "allow" };
  }
  if (TASK_TOOLS.has(tool)) {
    return denyWithCorrection(agent, tool, policy.correction);
  }
  if (SERVER_GATED_TOOLS.has(tool)) {
    return { action: "allow" };
  }
  if (BUILTIN_PASSTHROUGH.has(tool)) {
    return { action: "allow" };
  }
  if (tool === "browser") {
    return isToolAllowed(policy.tools, tool)
      ? { action: "allow" }
      : denyWithCorrection(agent, tool, policy.correction);
  }
  return isToolAllowed(policy.tools, tool)
    ? { action: "allow" }
    : denyWithCorrection(agent, tool, policy.correction);
}

function wildcardMatch(input, pattern) {
  let source = "";
  for (const ch of pattern) {
    if (ch === "*") {
      source += ".*";
    } else if (ch === "?") {
      source += ".";
    } else if (/[.+^\${}()|[\]\\]/.test(ch)) {
      source += "\\\\" + ch;
    } else {
      source += ch;
    }
  }
  return new RegExp("^" + source + "$").test(input);
}

function matchesBashDeny(command, patterns) {
  const lower = command.toLowerCase();
  return patterns.some(function (pattern) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      return false;
    }
    if (pattern.includes("*") || pattern.includes("?")) {
      return wildcardMatch(lower, pattern.toLowerCase());
    }
    return lower.includes(pattern.toLowerCase());
  });
}

function parsePatchFilePaths(patchText) {
  const found = [];
  const push = function (raw) {
    if (!raw) {
      return;
    }
    const cleaned = raw.trim().replace(/^["']|["']$/g, "");
    if (!cleaned || cleaned === "/dev/null" || found.includes(cleaned)) {
      return;
    }
    found.push(cleaned);
  };
  const lines = patchText.split("\\n");
  for (const line of lines) {
    const trimmed = line.trim();
    let m = /^\\+\\+\\+\\s+(?:b\\/)?(\\S+)\\s*$/.exec(trimmed);
    if (m) {
      push(m[1]);
      continue;
    }
    m = /^\\*\\*\\*\\s+(?:Update File|Add File|Delete File):\\s*(\\S+)\\s*$/.exec(trimmed);
    if (m) {
      push(m[1]);
    }
  }
  return found;
}

function buildDenyMessage(agent, tool, correction) {
  const scope = correction && typeof correction.scopeSummary === "string" ? correction.scopeSummary : "";
  const handoffTarget = resolveHandoffTarget(correction ? correction.handoff : undefined, tool);
  const template =
    correction && typeof correction.denyTemplate === "string" && correction.denyTemplate.length > 0
      ? correction.denyTemplate
      : null;
  if (!template) {
    return "【越界拦截｜角色：" + agent + "】不能调用 " + tool + "。";
  }
  return template
    .split("{role}")
    .join(agent)
    .split("<tool>")
    .join(tool)
    .split("{tool}")
    .join(tool)
    .split("<scopeSummary>")
    .join(scope)
    .split("{scopeSummary}")
    .join(scope)
    .split("{handoffTarget}")
    .join(handoffTarget);
}

function isToolAllowed(tools, tool) {
  if (!isPlainObject(tools) || !hasOwn(tools, tool)) {
    return false;
  }
  const effect = tools[tool];
  return effect === "allow" || effect === "ask";
}

function isEditDenied(targetPath, editMap) {
  const target = targetPath.replace(/\\\\/g, "/");
  for (const glob of Object.keys(editMap)) {
    if (glob !== "*" && editMap[glob] === "deny" && wildcardMatch(target, glob)) {
      return true;
    }
  }
  if (editMap["*"] === "deny") {
    const allowed = Object.keys(editMap).some(function (glob) {
      const effect = editMap[glob];
      return glob !== "*" && (effect === "allow" || effect === "ask") && wildcardMatch(target, glob);
    });
    if (!allowed) {
      return true;
    }
  }
  return false;
}

function extractEditTargets(tool, args) {
  if (!isPlainObject(args)) {
    return [];
  }
  const record = args;
  if (tool === "apply_patch" || tool === "patch") {
    const direct = pickString(record, ["filePath", "path"]);
    if (direct) {
      return [direct];
    }
    const text = pickString(record, ["patchText", "patch", "content", "diff"]);
    if (typeof text === "string" && text.length > 0) {
      return parsePatchFilePaths(text);
    }
    return [];
  }
  const direct = pickString(record, ["filePath", "path"]);
  if (direct) {
    return [direct];
  }
  const list = record["files"] !== undefined ? record["files"] : record["filePaths"];
  if (Array.isArray(list)) {
    const paths = list.filter(function (v) { return typeof v === "string" && v.length > 0; });
    if (paths.length > 0) {
      return paths;
    }
  }
  if (Array.isArray(record["edits"])) {
    const paths = [];
    for (const edit of record["edits"]) {
      if (isPlainObject(edit)) {
        const p = pickString(edit, ["filePath", "path"]);
        if (p && !paths.includes(p)) {
          paths.push(p);
        }
      }
    }
    if (paths.length > 0) {
      return paths;
    }
  }
  return [];
}

function pickString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function resolveHandoffTarget(handoff, tool) {
  if (!isPlainObject(handoff)) {
    return "";
  }
  const record = handoff;
  const byTool = record[tool];
  if (typeof byTool === "string" && byTool.length > 0) {
    return byTool;
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function readCorrection(role) {
  if (!isPlainObject(role)) {
    return null;
  }
  const correction = role.correction;
  if (!isPlainObject(correction)) {
    return null;
  }
  return correction;
}

function denyWithCorrection(agent, tool, correction) {
  return { action: "deny", message: buildDenyMessage(agent, tool, correction) };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
${DECISION_END}

function readJsonSafe(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

function sanitizeSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "unknown-session";
  }
  const cleaned = sessionId.replace(UNSAFE_SESSION_CHARS, "_").slice(0, 128);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "unknown-session";
  }
  return cleaned;
}

function findUpWorkDir(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    try {
      if (fs.existsSync(path.join(dir, GUARD_DIR_NAME, ROLES_FILE_NAME))) {
        return dir;
      }
    } catch {
      // ignore: 存取异常按"无标记"处理，继续上爬
    }
    try {
      if (fs.existsSync(path.join(dir, "opencode.json"))) {
        return dir;
      }
    } catch {
      // ignore: 同上
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

function locateWorkDir(factoryDir) {
  const starts = [];
  try {
    const selfFile = fileURLToPath(import.meta.url);
    starts.push(path.dirname(path.dirname(selfFile)));
  } catch {
    // 非 ESM/无 import.meta（如被打包为 CJS）：回退到工厂目录上爬
  }
  if (typeof factoryDir === "string" && factoryDir.length > 0) {
    starts.push(factoryDir);
  }
  try {
    starts.push(process.cwd());
  } catch {
    // ignore: cwd 不可用时仅靠前两个锚点
  }
  for (const start of starts) {
    const hit = findUpWorkDir(start);
    if (hit) {
      return hit;
    }
  }
  return typeof factoryDir === "string" && factoryDir.length > 0 ? factoryDir : process.cwd();
}

export const VteamRoleGuard = async (ctx) => {
  const factoryDir = ctx && typeof ctx.directory === "string" ? ctx.directory : "";
  const workDir = locateWorkDir(factoryDir);
  const guardDir = path.join(workDir, GUARD_DIR_NAME);
  return {
    "tool.execute.before": async (input, output) => {
      const tool = input.tool;
      const sessionID = input.sessionID;
      const args = output.args;
      const rolesDoc = readJsonSafe(path.join(guardDir, ROLES_FILE_NAME));
      const session = typeof sessionID === "string" && sessionID.length > 0
        ? readJsonSafe(path.join(guardDir, SESSIONS_DIR_NAME, sanitizeSessionId(sessionID) + ".json"))
        : null;
      const decision = evaluateToolCall({ rolesDoc: rolesDoc, session: session, tool: tool, args: args });
      if (decision.action === "deny") {
        throw new Error(decision.message);
      }
    },
  };
};
`;
}
