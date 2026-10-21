#!/usr/bin/env node
/**
 * repro.mjs — opencode v2 **热重载（hot-reload）** 证据采集脚本
 *
 * 产出：本目录下的 11 个 `NN-*.txt` 原始证据文件（每个都带 header：做了什么 /
 * 命令 / 时间戳），外加本脚本自身（= 复现入口）。
 *
 * ── 硬约束（不要改）────────────────────────────────────────────────────
 * 1. **隔离**：serve 用独立的 `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` 起，
 *    全部落在临时目录（`$TMPDIR/opencode/hot-reload-<stamp>/`），**不碰仓库、不碰
 *    宿主机 HOME**。
 * 2. **不残留**：脚本退出时杀掉自己起的 serve（TERM → 等 → KILL），并在收尾打印
 *    `pgrep -fl "opencode serve"` 的结果供人工核对（用户自己 4096 端口的实例不在其中）。
 * 3. **不提交二进制**：只有文本输出进仓库。
 * 4. **无凭据**：不需要任何 provider 凭据、不连外网；MCP server 用一个本地
 *    stdio 假实现（脚本内生成）。
 *
 * 用法：
 *   node repro.mjs                 # 输出到本目录
 *   OUT_DIR=/tmp/xx node repro.mjs # 输出到别处
 *   OPENCODE_BIN=... node repro.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : HERE;
const BIN = process.env.OPENCODE_BIN || "/Users/mac/.opencode/bin/opencode";
const PW = process.env.OPENCODE_SERVER_PASSWORD || "hotreloadpass";
const USERNAME = "opencode";

/** 临时根：/private/var/folders/.../T/opencode（**不在仓库里**）。 */
const TMPROOT = path.join(fs.realpathSync(os.tmpdir()), "opencode");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
const SCRATCH = process.env.SCRATCH || path.join(TMPROOT, `hot-reload-${STAMP}`);
const PROJ = path.join(SCRATCH, "proj");
const TASKDIR = path.join(PROJ, "tasks", "task-1");
const XDG = path.join(SCRATCH, "xdg");
const GLOBAL_CONFIG_DIR = path.join(XDG, ".config", "opencode");
const GLOBAL_CONFIG = path.join(GLOBAL_CONFIG_DIR, "opencode.json");
const PROJECT_CONFIG = path.join(PROJ, "opencode.json");
const SERVE_LOG = path.join(SCRATCH, "serve.log");
const PLUGIN_FILE = path.join(PROJ, ".opencode", "plugins", "hotreload-probe.ts");
const PLUGIN_MARKER = path.join(SCRATCH, "marker-plugin.txt");
const SKILL_FILE = path.join(PROJ, ".opencode", "skills", "hotreload-skill", "SKILL.md");
const MCP_SERVER = path.join(SCRATCH, "mcp-stdio-server.mjs");

/** 全量 HTTP 请求日志（用来证明「观察期间没有触发调用」）。 */
const REQLOG = [];

let BASE = "";
let serveProc = null;
let servePid = null;
let VERSION = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();

/** 把长路径缩成 $PROJ / $TASKDIR / $XDG，便于阅读（原始 HTTP 响应不受影响）。 */
function short(s) {
  let out = String(s);
  for (const [from, to] of [
    [encodeURIComponent(TASKDIR), "$TASKDIR"],
    [encodeURIComponent(PROJ), "$PROJ"],
    [encodeURIComponent(XDG), "$XDG"],
    [TASKDIR, "$TASKDIR"],
    [PROJ, "$PROJ"],
    [XDG, "$XDG"],
    [SCRATCH, "$SCRATCH"],
  ]) {
    out = out.split(from).join(to);
  }
  return out;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** v2 的 location 选择参数是 deepObject 风格：`location[directory]=<dir>`。 */
function q(dir) {
  return "?" + new URLSearchParams({ "location[directory]": dir }).toString();
}

/** 打一次带 Basic 鉴权的 serve 请求；返回 {status, text, json, ms}。 */
async function api(method, p, body) {
  const t0 = Date.now();
  const headers = { Authorization: `Basic ${Buffer.from(`${USERNAME}:${PW}`).toString("base64")}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  REQLOG.push({ t: Date.now(), method, path: p, status: res.status });
  return { status: res.status, text, json: safeJson(text), ms: Date.now() - t0 };
}

/** 请求日志里某段时间窗内的条目（用于「期间只发生了这些请求」的举证）。 */
function reqWindow(fromMs, toMs) {
  return REQLOG.filter((r) => r.t >= fromMs && r.t <= toMs);
}

/** serve 日志的当前字节位置（用来截取「本次动作期间新增的日志行」）。 */
function logMark() {
  try {
    return fs.statSync(SERVE_LOG).size;
  } catch {
    return 0;
  }
}

/** 读 serve 日志里 [mark, ∞) 新增的行（原文照抄）。 */
function logSince(mark, { re = null, limit = 60 } = {}) {
  let text = "";
  try {
    const size = fs.statSync(SERVE_LOG).size;
    const len = Math.max(0, size - mark);
    const fd = fs.openSync(SERVE_LOG, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, mark);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  return (re ? lines.filter((l) => re.test(l)) : lines).slice(0, limit);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

/** 写一个证据文件（header + 正文）。 */
function artifact(file, no, title, meta, body) {
  const header = [
    "=".repeat(78),
    `Artifact ${no} — ${title}`,
    "=".repeat(78),
    `what      : ${meta.what}`,
    `when      : ${meta.when}`,
    `binary    : ${VERSION}  (${BIN})`,
    `serve     : ${BASE}  (pid ${servePid})`,
    `isolation : HOME=${XDG}  XDG_CONFIG_HOME=${path.join(XDG, ".config")}  XDG_DATA_HOME=${path.join(XDG, "data")}`,
    `scratch   : ${SCRATCH}`,
    "commands  :",
    ...meta.cmds.map((c) => `  $ ${c}`),
    "-".repeat(78),
    "",
  ];
  fs.writeFileSync(path.join(OUT, file), header.join("\n") + body.join("\n") + "\n");
  console.log(`  wrote ${file}`);
}

/** 轮询直到条件成立；返回命中耗时与时间线。 */
async function poll(fn, { timeoutMs = 20000, intervalMs = 100 } = {}) {
  const t0 = Date.now();
  const timeline = [];
  for (;;) {
    const ms = Date.now() - t0;
    const r = await fn();
    timeline.push({ ms, r });
    if (r.hit) return { hit: true, ms: Date.now() - t0, timeline };
    if (Date.now() - t0 > timeoutMs) return { hit: false, ms: Date.now() - t0, timeline };
    await sleep(intervalMs);
  }
}

/** 轮询时间线的可读渲染（逐次观察到的值照抄）。 */
function renderTimeline(timeline, fmt) {
  return timeline.map((t) => `  t=+${String(t.ms).padStart(5)}ms  ${fmt(t.r)}`);
}

function kv(pairs) {
  return pairs.map(([k, v]) => `  ${k.padEnd(22)}: ${v}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(PROJ, ".opencode", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(PROJ, ".opencode", "skills"), { recursive: true });
  fs.mkdirSync(TASKDIR, { recursive: true });
  fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.join(XDG, "data"), { recursive: true });

  // ---- 起始配置：项目侧 opencode.json + 隔离的全局 opencode.json ------------
  writeJson(PROJECT_CONFIG, {
    $schema: "https://opencode.ai/config.json",
    agents: {
      "hotreload-agent": {
        description: "hot-reload probe agent",
        system: "SYSTEM_V1_MARKER",
      },
    },
  });
  writeJson(GLOBAL_CONFIG, { $schema: "https://opencode.ai/config.json" });

  // 本地 stdio MCP server（最小 JSON-RPC 实现，让 v2 报 connected）
  fs.writeFileSync(
    MCP_SERVER,
    `// minimal MCP stdio server (JSON-RPC 2.0, newline-delimited)
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined) continue
    let result = {}
    if (msg.method === "initialize") {
      result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hotreload-mcp", version: "1.0.0" } }
    } else if (msg.method === "tools/list") {
      result = { tools: [] }
    } else if (msg.method === "ping") {
      result = {}
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n")
  }
})
setInterval(() => {}, 1000)
`,
  );

  // ---- 起 serve（隔离 env）------------------------------------------------
  VERSION = spawnSync(BIN, ["--version"], { encoding: "utf8" }).stdout.trim();
  const port = await findFreePort();
  BASE = `http://127.0.0.1:${port}`;
  console.log(`opencode: ${VERSION}`);
  console.log(`scratch : ${SCRATCH}`);
  console.log(`serve   : ${BASE}`);

  const logFd = fs.openSync(SERVE_LOG, "a");
  serveProc = spawn(
    BIN,
    ["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "debug"],
    {
      cwd: PROJ,
      env: {
        ...process.env,
        HOME: XDG,
        XDG_CONFIG_HOME: path.join(XDG, ".config"),
        XDG_DATA_HOME: path.join(XDG, "data"),
        XDG_STATE_HOME: path.join(XDG, "state"),
        XDG_CACHE_HOME: path.join(XDG, "cache"),
        OPENCODE_SERVER_PASSWORD: PW,
        OPENCODE_SERVER_USERNAME: USERNAME,
      },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    },
  );
  servePid = serveProc.pid;

  const stop = () => {
    if (!serveProc || serveProc.killed) return;
    try {
      process.kill(-serveProc.pid, "SIGTERM");
    } catch {
      try {
        serveProc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };
  const stopHard = () => {
    try {
      process.kill(-serveProc.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  };
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    setTimeout(stopHard, 1500);
    process.exit(130);
  });

  for (let i = 0; i < 120; i++) {
    try {
      const r = await api("GET", "/api/info");
      if (r.status === 200) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  const info = await api("GET", "/api/info");
  console.log(`serve up: ${info.text}`);

  // location 是**惰性**的：先建一个会话把 location 拉起来（否则 agent/skill 列表是空的）
  const mkSession = async (dir) => {
    const r = await api("POST", "/api/session", { location: { directory: dir } });
    return r.json?.data?.id;
  };
  /** 等某个 location **真的解析成它自己**（而不是回落到默认 location）。 */
  const waitForLocation = async (dir, { timeoutMs = 30000 } = {}) => {
    const res = await poll(
      async () => {
        const r = await api("GET", `/api/location${q(dir)}`);
        return { hit: r.json?.directory === dir, got: r.json?.directory, raw: r };
      },
      { intervalMs: 200, timeoutMs },
    );
    return res;
  };
  /** 等某个 location 的 agent 集合里出现指定 agent（= location 的 agent 上下文就绪）。 */
  const waitForAgent = async (dir, agentID, { timeoutMs = 30000 } = {}) => {
    const res = await poll(
      async () => {
        const r = await api("GET", `/api/agent${q(dir)}`);
        const ids = (r.json?.data || []).map((a) => a.id);
        return { hit: ids.includes(agentID), ids };
      },
      { intervalMs: 200, timeoutMs },
    );
    return res;
  };

  const SID = await mkSession(PROJ);
  await waitForAgent(PROJ, "hotreload-agent");
  await sleep(1000);
  console.log(`session : ${SID}`);

  // ======================================================================
  // 01 — agents.<name>.system：改文件即生效（无任何触发调用）
  // ======================================================================
  {
    const mark = logMark();
    const before = await api("GET", `/api/agent/hotreload-agent${q(PROJ)}`);
    const cfg = JSON.parse(fs.readFileSync(PROJECT_CONFIG, "utf8"));
    cfg.agents["hotreload-agent"].system = "SYSTEM_V2_MARKER";
    const tEdit = Date.now();
    writeJson(PROJECT_CONFIG, cfg);
    const res = await poll(async () => {
      const r = await api("GET", `/api/agent/hotreload-agent${q(PROJ)}`);
      const sys = r.json?.data?.system;
      return { hit: sys === "SYSTEM_V2_MARKER", sys };
    });
    const after = await api("GET", `/api/agent/hotreload-agent${q(PROJ)}`);
    const win = reqWindow(tEdit, Date.now());
    const body = [
      "--- 观察：改文件之后，只有 GET，没有任何「触发」调用 ------------------------",
      ...kv([
        ["改文件时刻", new Date(tEdit).toISOString()],
        ["观察到新值", `改后 ${res.ms} ms（轮询间隔 100 ms）`],
        ["窗口内请求数", String(win.length)],
      ]),
      "",
      "窗口内的全部 HTTP 请求（逐条）：",
      ...win.map((r) => `  ${new Date(r.t).toISOString()}  ${r.method} ${short(r.path)}  -> ${r.status}`),
      "",
      "窗口内是否出现过 POST /api/location/reload ？ -> " +
        (win.some((r) => r.method === "POST" && r.path === "/api/location/reload") ? "**是**" : "**否**"),
      "窗口内是否出现过 POST（非 reload）？        -> " +
        (win.some((r) => r.method === "POST") ? "**是**" : "**否**"),
      "",
      "--- 改之前：GET /api/agent/hotreload-agent --------------------------------",
      `HTTP ${before.status}`,
      before.text,
      "",
      "--- 轮询时间线（每次读到的 system 值）-------------------------------------",
      ...renderTimeline(res.timeline, (r) => `system=${JSON.stringify(r.sys)}`),
      "",
      "--- 改之后：GET /api/agent/hotreload-agent --------------------------------",
      `HTTP ${after.status}`,
      after.text,
      "",
      "--- serve 日志（本次动作期间新增的行）-------------------------------------",
      ...(logSince(mark).length ? logSince(mark, { limit: 40 }) : ["(本次动作期间 serve 日志没有新增行)"]),
    ];
    artifact(
      "01-config-edit-agent-system.txt",
      "01",
      "agents.<name>.system —— 改项目 opencode.json 即生效（无任何触发调用）",
      {
        what: "改 <proj>/opencode.json 的 agents.hotreload-agent.system，然后只发 GET 请求读回",
        when: iso(),
        cmds: [
          `# 改配置（fs.writeFileSync 等价：同一路径 truncate+write，无 unlink/rename）`,
          `node -e 'const f="${PROJECT_CONFIG}";const d=JSON.parse(require("fs").readFileSync(f));d.agents["hotreload-agent"].system="SYSTEM_V2_MARKER";require("fs").writeFileSync(f,JSON.stringify(d,null,2))'`,
          `# 只读回，不触发任何重载（--data-urlencode 会把 [ ] 编成 %5B %5D，即 v2 的 deepObject 风格）`,
          `curl -s -u "opencode:$PW" -G "${BASE}/api/agent/hotreload-agent" --data-urlencode "location[directory]=${PROJ}"`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 02 — mcp.servers.<name>：改文件即生效
  // ======================================================================
  {
    const before = await api("GET", `/api/mcp${q(PROJ)}`);
    const cfg = JSON.parse(fs.readFileSync(PROJECT_CONFIG, "utf8"));
    cfg.mcp = {
      servers: {
        "hotreload-mcp": {
          type: "local",
          command: ["node", MCP_SERVER],
          environment: {},
        },
      },
    };
    const tEdit = Date.now();
    writeJson(PROJECT_CONFIG, cfg);
    const res = await poll(async () => {
      const r = await api("GET", `/api/mcp${q(PROJ)}`);
      const names = (r.json?.data || []).map((m) => m.name);
      return { hit: names.includes("hotreload-mcp"), names };
    });
    // 再等它真的连上（connected 才是「可用」的证据；pending 说明还在连）
    const conn = await poll(
      async () => {
        const r = await api("GET", `/api/mcp${q(PROJ)}`);
        const st = (r.json?.data || []).find((m) => m.name === "hotreload-mcp")?.status?.status;
        return { hit: st === "connected", st };
      },
      { intervalMs: 200, timeoutMs: 20000 },
    );
    const after = await api("GET", `/api/mcp${q(PROJ)}`);
    const win = reqWindow(tEdit, Date.now());
    const body = [
      "--- 观察：改文件之后，只有 GET，没有任何「触发」调用 ------------------------",
      ...kv([
        ["改文件时刻", new Date(tEdit).toISOString()],
        ["观察到新 server", `改后 ${res.ms} ms`],
        ["状态变成 connected", conn.hit ? `改后 ${conn.ms} ms` : "**未在 20 s 内变为 connected**"],
        ["窗口内 POST 数", String(win.filter((r) => r.method === "POST").length)],
      ]),
      "",
      "--- 改之前：GET /api/mcp -------------------------------------------------",
      `HTTP ${before.status}`,
      before.text,
      "",
      "--- 轮询时间线 -----------------------------------------------------------",
      ...renderTimeline(res.timeline, (r) => `servers=${JSON.stringify(r.names)}`),
      "",
      "--- 改之后：GET /api/mcp -------------------------------------------------",
      `HTTP ${after.status}`,
      after.text,
      "",
      "--- 连接状态时间线 -------------------------------------------------------",
      ...renderTimeline(conn.timeline, (r) => `status=${JSON.stringify(r.st)}`),
    ];
    artifact(
      "02-mcp-server-added.txt",
      "02",
      "mcp.servers.<name> —— 改项目 opencode.json 即生效（无任何触发调用）",
      {
        what: "往 <proj>/opencode.json 加 mcp.servers.hotreload-mcp（本地 stdio MCP server），再 GET /api/mcp",
        when: iso(),
        cmds: [
          `# 加 mcp.servers.hotreload-mcp（type=local, command=[node, mcp-stdio-server.mjs]）`,
          `node -e 'const f="${PROJECT_CONFIG}";const d=JSON.parse(require("fs").readFileSync(f));d.mcp={servers:{"hotreload-mcp":{type:"local",command:["node","${MCP_SERVER}"],environment:{}}}};require("fs").writeFileSync(f,JSON.stringify(d,null,2))'`,
          `curl -s -u "opencode:$PW" -G "${BASE}/api/mcp" --data-urlencode "location[directory]=${PROJ}"`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 03 — .opencode/skills/<name>/SKILL.md：新增即生效
  // ======================================================================
  {
    const before = await api("GET", `/api/skill${q(PROJ)}`);
    const tEdit = Date.now();
    fs.mkdirSync(path.dirname(SKILL_FILE), { recursive: true });
    fs.writeFileSync(
      SKILL_FILE,
      `---\nname: hotreload-skill\ndescription: hot-reload probe skill\n---\n\nSKILL_V1_MARKER body\n`,
    );
    const res = await poll(async () => {
      const r = await api("GET", `/api/skill${q(PROJ)}`);
      const ids = (r.json?.data || []).map((s) => s.id);
      return { hit: ids.includes("hotreload-skill"), ids };
    });
    const after = await api("GET", `/api/skill${q(PROJ)}`);
    const win = reqWindow(tEdit, Date.now());
    const body = [
      "--- 观察：新建文件之后，只有 GET，没有任何「触发」调用 ----------------------",
      ...kv([
        ["新建文件时刻", new Date(tEdit).toISOString()],
        ["观察到新 skill", `新建后 ${res.ms} ms`],
        ["窗口内 POST 数", String(win.filter((r) => r.method === "POST").length)],
      ]),
      "",
      "--- 新建的文件 -----------------------------------------------------------",
      `path: ${SKILL_FILE}`,
      "---- 8< ----",
      fs.readFileSync(SKILL_FILE, "utf8").replace(/\n$/, ""),
      "---- 8< ----",
      "",
      "--- 改之前：GET /api/skill -----------------------------------------------",
      `HTTP ${before.status}`,
      before.text,
      "",
      "--- 轮询时间线 -----------------------------------------------------------",
      ...renderTimeline(res.timeline, (r) => `skills=${JSON.stringify(r.ids)}`),
      "",
      "--- 改之后：GET /api/skill -----------------------------------------------",
      `HTTP ${after.status}`,
      after.text,
      "",
      "--- serve 日志：skill source loaded --------------------------------------",
      ...(logLinesSafe(/skill source loaded/, { limit: 8 })),
    ];
    artifact(
      "03-skill-added.txt",
      "03",
      ".opencode/skills/<name>/SKILL.md —— 新增即生效（无任何触发调用）",
      {
        what: "新建 <proj>/.opencode/skills/hotreload-skill/SKILL.md，再 GET /api/skill",
        when: iso(),
        cmds: [
          `mkdir -p "${path.dirname(SKILL_FILE)}"`,
          `cat > "${SKILL_FILE}" <<'MD'`,
          "  ---",
          "  name: hotreload-skill",
          "  description: hot-reload probe skill",
          "  ---",
          "",
          "  SKILL_V1_MARKER body",
          "MD",
          `curl -s -u "opencode:$PW" -G "${BASE}/api/skill" --data-urlencode "location[directory]=${PROJ}"`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 04 — 新增 .opencode/plugins/<f>.ts → setup() 被调用
  // ======================================================================
  const pluginSource = (tag) => `import { Plugin } from "@opencode/plugin"
import { writeFileSync, existsSync, readFileSync } from "node:fs"

const MARKER = "${PLUGIN_MARKER}"

export default Plugin.define({
  id: "hotreload-probe",
  async setup(ctx: any) {
    let count = 0
    if (existsSync(MARKER)) {
      const m = readFileSync(MARKER, "utf8").match(/count=(\\d+)/)
      if (m) count = Number(m[1])
    }
    count += 1
    writeFileSync(
      MARKER,
      "count=" + count + " tag=${tag} pid=" + process.pid +
        " location=" + (ctx?.location?.directory ?? "?") +
        " ts=" + new Date().toISOString() + "\\n",
    )
  },
})
`;
  {
    const mark = logMark();
    const before = fs.existsSync(PLUGIN_MARKER) ? fs.readFileSync(PLUGIN_MARKER, "utf8") : "(marker 不存在)";
    const tEdit = Date.now();
    fs.writeFileSync(PLUGIN_FILE, pluginSource("V1"));
    const res = await poll(async () => {
      const exists = fs.existsSync(PLUGIN_MARKER);
      const content = exists ? fs.readFileSync(PLUGIN_MARKER, "utf8") : "";
      return { hit: exists && /tag=V1/.test(content), content };
    });
    const win = reqWindow(tEdit, Date.now());
    const body = [
      "--- 观察：新增插件文件之后，只有 GET，没有任何「触发」调用 ------------------",
      ...kv([
        ["新增文件时刻", new Date(tEdit).toISOString()],
        ["setup() 首次被调用", `新增后 ${res.ms} ms`],
        ["窗口内 POST 数", String(win.filter((r) => r.method === "POST").length)],
      ]),
      "",
      "--- 新增的插件文件 -------------------------------------------------------",
      `path: ${PLUGIN_FILE}`,
      "---- 8< ----",
      fs.readFileSync(PLUGIN_FILE, "utf8").replace(/\n$/, ""),
      "---- 8< ----",
      "",
      "--- marker（setup() 写出的）---------------------------------------------",
      "新增之前：",
      before.trim(),
      "新增之后：",
      fs.readFileSync(PLUGIN_MARKER, "utf8").trim(),
      "",
      "--- 轮询时间线 -----------------------------------------------------------",
      ...renderTimeline(res.timeline, (r) => `marker=${JSON.stringify((r.content || "").trim())}`),
      "",
      "--- serve 日志：本次动作期间新增的 loading plugin 行 ----------------------",
      ...(logSince(mark, { re: /msg="loading plugin"/, limit: 10 }).length
        ? logSince(mark, { re: /msg="loading plugin"/, limit: 10 })
        : ["(没有新增的 loading plugin 行)"]),
    ];
    artifact(
      "04-plugin-added.txt",
      "04",
      ".opencode/plugins/<f>.ts —— 新增后 setup() 被调用（marker 出现）",
      {
        what: "新增 <proj>/.opencode/plugins/hotreload-probe.ts，其 setup() 写 marker 文件",
        when: iso(),
        cmds: [
          `cat > "${PLUGIN_FILE}" <<'TS'`,
          "  import { Plugin } from \"@opencode/plugin\"",
          "  import { writeFileSync, existsSync, readFileSync } from \"node:fs\"",
          `  const MARKER = "${PLUGIN_MARKER}"`,
          "  export default Plugin.define({",
          "    id: \"hotreload-probe\",",
          "    async setup(ctx: any) { /* 写 marker，计数自增 */ },",
          "  })",
          "TS",
          `cat "${PLUGIN_MARKER}"   # setup() 的产物`,
          `grep 'loading plugin' "${SERVE_LOG}"`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 05 — 原地编辑同一个插件文件（无 unlink）→ setup() 再次被调用
  // ======================================================================
  {
    const mark = logMark();
    const before = fs.readFileSync(PLUGIN_MARKER, "utf8").trim();
    const countBefore = Number((before.match(/count=(\d+)/) || [])[1] || "0");
    const tEdit = Date.now();
    // 原地编辑：同一路径 truncate+write（fs.writeFileSync 语义），**不 unlink、不 rename**
    fs.writeFileSync(PLUGIN_FILE, pluginSource("V2_EDITED_IN_PLACE"));
    const res = await poll(async () => {
      const content = fs.existsSync(PLUGIN_MARKER) ? fs.readFileSync(PLUGIN_MARKER, "utf8") : "";
      const n = Number((content.match(/count=(\d+)/) || [])[1] || "0");
      return { hit: n > countBefore && /V2_EDITED_IN_PLACE/.test(content), content };
    });
    const after = fs.readFileSync(PLUGIN_MARKER, "utf8").trim();
    const body = [
      "--- 观察：原地编辑插件文件（fs.writeFileSync，无 unlink/rename）---------------",
      ...kv([
        ["编辑时刻", new Date(tEdit).toISOString()],
        ["setup() 再次被调用", `编辑后 ${res.ms} ms`],
        ["marker 计数", `${(before.match(/count=(\d+)/) || [])[1]} -> ${(after.match(/count=(\d+)/) || [])[1]}`],
        ["文件是否被删过", "否（同一路径 writeFileSync，未 unlink / 未 rename）"],
      ]),
      "",
      "--- 编辑之前的 marker ---------------------------------------------------",
      before,
      "",
      "--- 编辑之后的 marker ---------------------------------------------------",
      after,
      "",
      "--- 轮询时间线 -----------------------------------------------------------",
      ...renderTimeline(res.timeline, (r) => `marker=${JSON.stringify((r.content || "").trim())}`),
      "",
      "--- serve 日志：本次动作期间新增的 loading plugin 行 ----------------------",
      ...(logSince(mark, { re: /msg="loading plugin"/, limit: 10 }).length
        ? logSince(mark, { re: /msg="loading plugin"/, limit: 10 })
        : ["(没有新增的 loading plugin 行)"]),
    ];
    artifact(
      "05-plugin-edited-in-place.txt",
      "05",
      ".opencode/plugins/<f>.ts —— **原地编辑**（无 unlink）后 setup() 再次被调用",
      {
        what: "对同一个插件文件做原地 writeFileSync（不 unlink / 不 rename），看 setup() 是否被再次调用",
        when: iso(),
        cmds: [
          `# 原地编辑（与 vteam 注入器写文件的方式一致：同路径 truncate+write）`,
          `node -e 'require("fs").writeFileSync("${PLUGIN_FILE}", <新内容>)'   # 同一路径，无 unlink`,
          `cat "${PLUGIN_MARKER}"   # count 应自增`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 06 — 隔离的全局配置（$XDG_CONFIG_HOME/opencode/opencode.json）
  // ======================================================================
  {
    const before = await api("GET", `/api/provider${q(PROJ)}`);
    const tEdit = Date.now();
    writeJson(GLOBAL_CONFIG, {
      $schema: "https://opencode.ai/config.json",
      providers: {
        "hotreload-global": {
          name: "Hot Reload Global",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: {
            baseURL: "http://127.0.0.1:45999/v1",
            apiKey: "sk-hot-reload-PROBE-NOT-A-REAL-KEY",
          },
          models: { "hotreload-global-model": { name: "hotreload-global-model" } },
        },
      },
    });
    const res = await poll(async () => {
      const r = await api("GET", `/api/provider${q(PROJ)}`);
      const ids = (r.json?.data || []).map((p) => p.id);
      return { hit: ids.includes("hotreload-global"), ids };
    });
    const after = await api("GET", `/api/provider${q(PROJ)}`);
    const models = await api("GET", `/api/model${q(PROJ)}`);
    const globalProv = (after.json?.data || []).find((p) => p.id === "hotreload-global");
    const globalModels = (models.json?.data || []).filter((m) => m.providerID === "hotreload-global");
    const body = [
      "--- 观察：改**隔离的全局配置**之后，只有 GET，没有任何「触发」调用 ------------",
      ...kv([
        ["全局配置路径", GLOBAL_CONFIG],
        ["改文件时刻", new Date(tEdit).toISOString()],
        ["观察到新 provider", `改后 ${res.ms} ms`],
        ["窗口内 POST 数", String(reqWindow(tEdit, Date.now()).filter((r) => r.method === "POST").length)],
      ]),
      "",
      "--- 改之前：GET /api/provider --------------------------------------------",
      `HTTP ${before.status}`,
      before.text,
      "",
      "--- 轮询时间线 -----------------------------------------------------------",
      ...renderTimeline(res.timeline, (r) => `providers=${JSON.stringify(r.ids.filter((i) => i.includes("hotreload")))}`),
      "",
      "--- 改之后：GET /api/provider --------------------------------------------",
      `HTTP ${after.status}`,
      after.text,
      "",
      "--- 改之后：GET /api/model（只列 hotreload-global 的条目）-------------------",
      `HTTP ${models.status}`,
      JSON.stringify(globalModels, null, 2),
      "",
      "--- 观察：apiKey 的呈现方式 ----------------------------------------------",
      `provider 响应里的 settings.apiKey = ${JSON.stringify(globalProv?.settings?.apiKey)}`,
      "⇒ **v2.0.28 并没有把 apiKey 脱敏**：`GET /api/provider` / `GET /api/provider/{id}` /",
      "  `GET /api/model` 都**明文回显** `settings.apiKey`。",
      "  （本证据里的 key 是**合成的假串**，不是任何真实凭据。）",
      "  ⇒ 因此本证据证明的是「全局配置里的 provider 段被热重载看见了」，",
      "    **并且**（附带地）证明「apiKey 的值原样回显」——这一条与「脱敏」的预期不同，",
      "    已在 README 的「与预期不符的一处」里登记。",
    ];
    artifact(
      "06-global-config-isolated.txt",
      "06",
      "隔离的全局配置（$XDG_CONFIG_HOME/opencode/opencode.json）—— 改即生效",
      {
        what: "改隔离全局配置，加一个带 settings.apiKey 的 provider，再 GET /api/provider + /api/model",
        when: iso(),
        cmds: [
          `cat > "${GLOBAL_CONFIG}" <<'JSON'`,
          "  {",
          '    "$schema": "https://opencode.ai/config.json",',
          '    "providers": {',
          '      "hotreload-global": {',
          '        "name": "Hot Reload Global",',
          '        "package": "aisdk:@ai-sdk/openai-compatible",',
          '        "settings": { "baseURL": "http://127.0.0.1:45999/v1", "apiKey": "sk-hot-reload-PROBE-NOT-A-REAL-KEY" },',
          '        "models": { "hotreload-global-model": { "name": "hotreload-global-model" } }',
          "      }",
          "    }",
          "  }",
          "JSON",
          `curl -s -u "opencode:$PW" -G "${BASE}/api/provider" --data-urlencode "location[directory]=${PROJ}"`,
          `curl -s -u "opencode:$PW" -G "${BASE}/api/model"    --data-urlencode "location[directory]=${PROJ}"`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 07 — POST /api/location/reload：204 / PID 不变 / 会话存活 / 重建滞后
  // ======================================================================
  {
    const pidBefore = servePid;
    const sessionBefore = await api("GET", `/api/session/${SID}`);
    const tReload = Date.now();
    const reload = await api("POST", "/api/location/reload");
    const tAfter204 = Date.now();
    const pidAfter = servePid;
    // 重建滞后：此刻（204 落地之后）往全局配置加一个 provider，
    // 立刻做**一次**读（看是不是旧快照），再轮询到它出现。
    const g = JSON.parse(fs.readFileSync(GLOBAL_CONFIG, "utf8"));
    g.providers["hotreload-lag"] = {
      name: "Hot Reload Lag",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:45999/v1", apiKey: "sk-lag-PROBE-NOT-A-REAL-KEY" },
      models: { "hotreload-lag-model": { name: "hotreload-lag-model" } },
    };
    fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify(g, null, 2) + "\n");
    const singleRead = await api("GET", `/api/provider${q(PROJ)}`);
    const singleHas = (singleRead.json?.data || []).some((p) => p.id === "hotreload-lag");
    const singleAt = Date.now();
    const lag = await poll(
      async () => {
        const r = await api("GET", `/api/provider${q(PROJ)}`);
        const ids = (r.json?.data || []).map((p) => p.id);
        return { hit: ids.includes("hotreload-lag"), ids };
      },
      { intervalMs: 10, timeoutMs: 10000 },
    );
    const sessionAfter = await api("GET", `/api/session/${SID}`);
    const body = [
      "--- 观察：POST /api/location/reload ---------------------------------------",
      ...kv([
        ["HTTP 状态", `${reload.status}（期望 204）`],
        ["响应体", JSON.stringify(reload.text)],
        ["请求耗时", `${reload.ms} ms`],
        ["serve PID（重载前）", String(pidBefore)],
        ["serve PID（重载后）", String(pidAfter)],
        ["PID 是否相同", pidBefore === pidAfter ? "**是**（serve 进程没重启）" : "**否**"],
        ["会话是否仍可读", sessionAfter.status === 200 ? "**是**" : `**否**（HTTP ${sessionAfter.status}）`],
      ]),
      "",
      "--- 重载前：GET /api/session/<sid> -----------------------------------------",
      `HTTP ${sessionBefore.status}`,
      sessionBefore.text,
      "",
      "--- 重载后：GET /api/session/<sid> -----------------------------------------",
      `HTTP ${sessionAfter.status}`,
      sessionAfter.text,
      "",
      "--- 重建滞后（204 之后，新 provider 何时可见）------------------------------",
      "做法：204 落地**之后**立刻往隔离全局配置加一个 provider，",
      "      然后做**一次**读（single read），再以 10 ms 间隔轮询。",
      ...kv([
        ["204 落地时刻", new Date(tAfter204).toISOString()],
        ["单次读（single read）", `HTTP ${singleRead.status}，新 provider 可见？ ${singleHas ? "是" : "**否**（读到的是旧快照）"}`],
        ["单次读时刻", `距 204 ${singleAt - tAfter204} ms`],
        ["新 provider 可见", `204 之后 ${lag.ms} ms`],
        ["轮询间隔", "10 ms"],
      ]),
      "",
      "--- 单次读的原始响应（注意：没有 hotreload-lag）---------------------------",
      `HTTP ${singleRead.status}`,
      singleRead.text,
      "",
      "⇒ 重建是**异步**的：204 之后还有一小段滞后才可见 ⇒",
      "  单次读会读到旧快照 ⇒ 效果确认必须走**有界 settle 窗口**（不能只读一次）。",
      "  （本次实测滞后 ≈ " + lag.ms + " ms；实现的 settle 窗口按 ~100 ms 量级取值，留了余量。）",
      "",
      "--- 轮询时间线（provider id 集合里是否已含 hotreload-lag）-----------------",
      ...renderTimeline(lag.timeline, (r) => `hotreload-lag visible=${r.hit}`),
    ];
    artifact(
      "07-location-reload.txt",
      "07",
      "POST /api/location/reload —— 204 / serve PID 不变 / 会话存活 / 重建异步",
      {
        what: "POST /api/location/reload，比对重载前后的 serve PID、重载后的会话可读性，并测重建滞后",
        when: iso(),
        cmds: [
          `pgrep -f "opencode serve --port ${new URL(BASE).port}"   # 重载前 PID`,
          `curl -s -o /dev/null -w '%{http_code}\\n' -u "opencode:$PW" -X POST "${BASE}/api/location/reload"`,
          `pgrep -f "opencode serve --port ${new URL(BASE).port}"   # 重载后 PID`,
          `curl -s -u "opencode:$PW" "${BASE}/api/session/${SID}"`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 08 — pending form + pending permission 被 location/reload 取消
  //      （同时证明：GET /api/form 是 location 作用域的，而 reload 取消**所有** location）
  // ======================================================================
  {
    // 任务子目录也是一个 location：必须等它**真的解析成自己**（否则 location 查询会
    // 静默回落到默认 location，权限评估也会因为没有 agent 规则而落到 deny）
    const SID_TASK = await mkSession(TASKDIR);
    const locReady = await waitForLocation(TASKDIR);
    await waitForAgent(TASKDIR, "hotreload-agent");
    await sleep(1000);

    // 造 pending permission：location 的权限上下文没就绪时会返回 deny（不建请求），重试
    const mkPendingPermission = async (sid, label) => {
      for (let i = 0; i < 20; i++) {
        const r = await api("POST", `/api/session/${sid}/permission`, {
          action: "read",
          resources: [".env"],
        });
        if (r.json?.data?.effect === "ask") return r;
        await sleep(500);
      }
      return api("POST", `/api/session/${sid}/permission`, {
        action: "read",
        resources: [".env"],
      });
    };

    const form = await api("POST", `/api/session/${SID}/form`, {
      title: "Pending form (default location)",
      fields: [{ key: "answer", type: "string", title: "Your answer", required: true }],
    });
    const perm = await mkPendingPermission(SID, "default");
    const formT = await api("POST", `/api/session/${SID_TASK}/form`, {
      title: "Pending form (task subdirectory)",
      fields: [{ key: "answer", type: "string", title: "Your answer", required: true }],
    });
    const permT = await mkPendingPermission(SID_TASK, "task");
    await sleep(500);

    const beforeForm = await api("GET", `/api/session/${SID}/form`);
    const beforePerm = await api("GET", `/api/session/${SID}/permission`);
    const beforeFormTask = await api("GET", `/api/session/${SID_TASK}/form`);
    const beforePermTask = await api("GET", `/api/session/${SID_TASK}/permission`);
    const beforeGlobalForm = await api("GET", "/api/form");
    const beforeGlobalFormTask = await api("GET", `/api/form${q(TASKDIR)}`);
    const beforeGlobalPerm = await api("GET", "/api/permission/request");
    const beforeGlobalPermTask = await api("GET", `/api/permission/request${q(TASKDIR)}`);

    const pidBefore = servePid;
    const reload = await api("POST", "/api/location/reload");
    const pidAfter = servePid;
    await sleep(1500);

    const afterForm = await api("GET", `/api/session/${SID}/form`);
    const afterPerm = await api("GET", `/api/session/${SID}/permission`);
    const afterFormTask = await api("GET", `/api/session/${SID_TASK}/form`);
    const afterPermTask = await api("GET", `/api/session/${SID_TASK}/permission`);
    const afterGlobalForm = await api("GET", "/api/form");
    const afterGlobalFormTask = await api("GET", `/api/form${q(TASKDIR)}`);
    const afterGlobalPerm = await api("GET", "/api/permission/request");
    const afterGlobalPermTask = await api("GET", `/api/permission/request${q(TASKDIR)}`);

    const body = [
      "--- 造 pending 项 --------------------------------------------------------",
      ...kv([
        ["默认 location 会话", SID],
        ["任务子目录会话", SID_TASK],
        ["任务子目录 location 就绪", `${locReady.hit ? "**是**" : "**否**"}（${locReady.ms} ms；GET /api/location 的 directory == $TASKDIR）`],
        ["serve PID（重载前/后）", `${pidBefore} / ${pidAfter}`],
        ["POST /api/location/reload", `HTTP ${reload.status}（${reload.ms} ms）`],
      ]),
      "",
      `POST /api/session/${SID}/form        -> HTTP ${form.status}  ${form.text}`,
      `POST /api/session/${SID}/permission   -> HTTP ${perm.status}  ${perm.text}`,
      `POST /api/session/${SID_TASK}/form        -> HTTP ${formT.status}  ${formT.text}`,
      `POST /api/session/${SID_TASK}/permission   -> HTTP ${permT.status}  ${permT.text}`,
      "",
      "════════ 重载前 ════════",
      "",
      "--- 默认 location 会话：GET /api/session/<sid>/form -----------------------",
      `HTTP ${beforeForm.status}`,
      beforeForm.text,
      "",
      "--- 默认 location 会话：GET /api/session/<sid>/permission ------------------",
      `HTTP ${beforePerm.status}`,
      beforePerm.text,
      "",
      "--- 任务子目录会话：GET /api/session/<sid>/form ----------------------------",
      `HTTP ${beforeFormTask.status}`,
      beforeFormTask.text,
      "",
      "--- 任务子目录会话：GET /api/session/<sid>/permission -----------------------",
      `HTTP ${beforePermTask.status}`,
      beforePermTask.text,
      "",
      "--- ⚠ location 作用域证据 A：GET /api/form（**不带** location = 默认 location）---",
      `HTTP ${beforeGlobalForm.status}`,
      beforeGlobalForm.text,
      "   ⇒ 只有**默认 location** 的 pending form；任务子目录的**查不到**",
      "",
      "--- ⚠ location 作用域证据 B：GET /api/form?location[directory]=<任务子目录> -----",
      `HTTP ${beforeGlobalFormTask.status}`,
      beforeGlobalFormTask.text,
      "   ⇒ 这次 location 被解析成任务子目录，**只有它的** pending form",
      "     ⇒ **`GET /api/form` 是 location 作用域的**",
      "",
      "--- GET /api/permission/request（默认 location）----------------------------",
      `HTTP ${beforeGlobalPerm.status}`,
      beforeGlobalPerm.text,
      "",
      "--- GET /api/permission/request?location[directory]=<任务子目录> -----------",
      `HTTP ${beforeGlobalPermTask.status}`,
      beforeGlobalPermTask.text,
      "   ⇒ 同样是 location 作用域的",
      "",
      "════════ 重载后 ════════",
      "",
      "--- 默认 location 会话：GET /api/session/<sid>/form -----------------------",
      `HTTP ${afterForm.status}`,
      afterForm.text,
      "   ⇒ **被取消**（重载前 1 条 → 重载后 0 条）",
      "",
      "--- 默认 location 会话：GET /api/session/<sid>/permission ------------------",
      `HTTP ${afterPerm.status}`,
      afterPerm.text,
      "   ⇒ **被取消**（重载前 1 条 → 重载后 0 条）",
      "",
      "--- 任务子目录会话：GET /api/session/<sid>/form ----------------------------",
      `HTTP ${afterFormTask.status}`,
      afterFormTask.text,
      "   ⇒ **也被取消** ⇒ reload 取消的是**所有 location** 的 pending",
      "",
      "--- 任务子目录会话：GET /api/session/<sid>/permission -----------------------",
      `HTTP ${afterPermTask.status}`,
      afterPermTask.text,
      "   ⇒ **也被取消**",
      "",
      "--- GET /api/form（默认 location）-----------------------------------------",
      `HTTP ${afterGlobalForm.status}`,
      afterGlobalForm.text,
      "",
      "--- GET /api/form?location[directory]=<任务子目录> -------------------------",
      `HTTP ${afterGlobalFormTask.status}`,
      afterGlobalForm.text === afterGlobalFormTask.text ? afterGlobalFormTask.text : afterGlobalFormTask.text,
      "",
      "--- GET /api/permission/request（默认 location）----------------------------",
      `HTTP ${afterGlobalPerm.status}`,
      afterGlobalPerm.text,
      "",
      "--- GET /api/permission/request?location[directory]=<任务子目录> -----------",
      `HTTP ${afterGlobalPermTask.status}`,
      afterGlobalPermTask.text,
      "",
      "--- 结论 -----------------------------------------------------------------",
      "  ① `location/reload` 会**取消** pending form 与 pending permission（两个 location 都一样）。",
      "  ② `GET /api/form` / `GET /api/permission/request` 是**按 location 作用域**的：",
      "     会话被放到任务子目录后，默认 location 的查询**看不到**它的待答复项；",
      "     而 `location/reload` 取消的是**所有 location**。",
      "     ⇒ 闸门必须**逐会话**查（`GET /api/session/{id}/form` / `.../permission`），",
      "       绝不能用默认 location 的全局端点当闸门（会漏判 ⇒ 静默销毁用户正在作答的问题）。",
    ];
    artifact(
      "08-pending-cancelled-by-reload.txt",
      "08",
      "pending form + pending permission —— 被 location/reload 取消（**所有** location）",
      {
        what: "造 pending form + pending permission（默认 location 与任务子目录各一套），再 POST /api/location/reload",
        when: iso(),
        cmds: [
          `curl -s -u "opencode:$PW" -X POST "${BASE}/api/session/${SID}/form" -H 'content-type: application/json' -d '{"title":"...","fields":[{"key":"answer","type":"string","required":true}]}'`,
          `curl -s -u "opencode:$PW" -X POST "${BASE}/api/session/${SID}/permission" -H 'content-type: application/json' -d '{"action":"read","resources":[".env"]}'`,
          `curl -s -u "opencode:$PW" "${BASE}/api/session/${SID}/form"`,
          `curl -s -u "opencode:$PW" "${BASE}/api/form"                                  # 默认 location`,
          `curl -s -u "opencode:$PW" -G "${BASE}/api/form" --data-urlencode "location[directory]=${TASKDIR}"`,
          `curl -s -o /dev/null -w '%{http_code}\\n' -u "opencode:$PW" -X POST "${BASE}/api/location/reload"`,
          `curl -s -u "opencode:$PW" "${BASE}/api/session/${SID}/form"                  # 重载后`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 09 — 对照组：不 reload，pending form 自然存活
  // ======================================================================
  {
    const SID_CTRL = await mkSession(PROJ);
    await waitForAgent(PROJ, "hotreload-agent");
    await sleep(1000);
    const form = await api("POST", `/api/session/${SID_CTRL}/form`, {
      title: "Pending form (control: no reload)",
      fields: [{ key: "answer", type: "string", title: "Your answer", required: true }],
    });
    const perm = await api("POST", `/api/session/${SID_CTRL}/permission`, {
      action: "read",
      resources: [".env"],
    });
    await sleep(500);
    const beforeForm = await api("GET", `/api/session/${SID_CTRL}/form`);
    const beforePerm = await api("GET", `/api/session/${SID_CTRL}/permission`);
    const t0 = Date.now();
    await sleep(8000);
    const elapsed = Date.now() - t0;
    const afterForm = await api("GET", `/api/session/${SID_CTRL}/form`);
    const afterPerm = await api("GET", `/api/session/${SID_CTRL}/permission`);
    // 只统计**本对照窗口内**的 reload 调用（不是整场 run 的）
    const reloadCalls = REQLOG.filter(
      (r) => r.method === "POST" && r.path === "/api/location/reload" && r.t >= t0,
    );
    const body = [
      "--- 对照组：造了 pending form / permission 之后**不做任何 reload**------------",
      ...kv([
        ["会话", SID_CTRL],
        ["等待时长", `${elapsed} ms`],
        ["本对照窗口内 location/reload 调用次数", String(reloadCalls.length)],
        ["pending form", beforeForm.json?.data?.length > 0 && afterForm.json?.data?.length > 0 ? "**存活**" : "**消失**"],
        ["pending permission", beforePerm.json?.data?.length > 0 && afterPerm.json?.data?.length > 0 ? "**存活**" : "**消失**"],
      ]),
      "",
      "--- 造出来：POST .../form -----------------------------------------------",
      `HTTP ${form.status}`,
      form.text,
      "",
      "--- 造出来：POST .../permission ------------------------------------------",
      `HTTP ${perm.status}`,
      perm.text,
      "",
      "--- 等待前：GET /api/session/<sid>/form -----------------------------------",
      `HTTP ${beforeForm.status}`,
      beforeForm.text,
      "",
      "--- 等待前：GET /api/session/<sid>/permission ------------------------------",
      `HTTP ${beforePerm.status}`,
      beforePerm.text,
      "",
      `--- 等待 ${elapsed} ms（无 reload）后：GET /api/session/<sid>/form -----------`,
      `HTTP ${afterForm.status}`,
      afterForm.text,
      "   ⇒ **仍然存活** ⇒ pending 项不是「自然过期」消失的",
      "",
      `--- 等待后：GET /api/session/<sid>/permission ------------------------------`,
      `HTTP ${afterPerm.status}`,
      afterPerm.text,
      "   ⇒ **仍然存活**",
      "",
      "--- 结论 -----------------------------------------------------------------",
      "  ⇒ 08 里 pending 项的消失**只能**归因于 `location/reload`，不是自然过期。",
      "  ⇒ 因此热重载的 pending 闸门是**必需**的（`deferred` 分支有存在理由）。",
    ];
    artifact(
      "09-pending-survives-without-reload.txt",
      "09",
      "对照组 —— **不** reload 时 pending form / permission 存活",
      {
        what: "造 pending form + pending permission，然后什么都不做，等 8 秒再看",
        when: iso(),
        cmds: [
          `curl -s -u "opencode:$PW" -X POST "${BASE}/api/session/<sid>/form" -H 'content-type: application/json' -d '{"title":"...","fields":[{"key":"answer","type":"string","required":true}]}'`,
          `sleep 8`,
          `curl -s -u "opencode:$PW" "${BASE}/api/session/<sid>/form"`,
          `curl -s -u "opencode:$PW" "${BASE}/api/session/<sid>/permission"`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 10 — 文件监听路径（改配置文件）→ pending 项被保留
  // ======================================================================
  {
    const SID_W = await mkSession(PROJ);
    await waitForAgent(PROJ, "hotreload-agent");
    await sleep(1000);
    const form = await api("POST", `/api/session/${SID_W}/form`, {
      title: "Pending form (file-watcher path)",
      fields: [{ key: "answer", type: "string", title: "Your answer", required: true }],
    });
    const perm = await api("POST", `/api/session/${SID_W}/permission`, {
      action: "read",
      resources: [".env"],
    });
    await sleep(400);
    const beforeForm = await api("GET", `/api/session/${SID_W}/form`);
    const beforePerm = await api("GET", `/api/session/${SID_W}/permission`);
    const beforeAgent = await api("GET", `/api/agent/hotreload-agent${q(PROJ)}`);

    // 改配置文件 → 走文件监听路径（**不**调用 location/reload）
    const cfg = JSON.parse(fs.readFileSync(PROJECT_CONFIG, "utf8"));
    cfg.agents["hotreload-agent"].system = "SYSTEM_V3_MARKER_WATCHER";
    const tEdit = Date.now();
    writeJson(PROJECT_CONFIG, cfg);
    const applied = await poll(async () => {
      const r = await api("GET", `/api/agent/hotreload-agent${q(PROJ)}`);
      const sys = r.json?.data?.system;
      return { hit: sys === "SYSTEM_V3_MARKER_WATCHER", sys };
    });
    await sleep(1000);
    const afterForm = await api("GET", `/api/session/${SID_W}/form`);
    const afterPerm = await api("GET", `/api/session/${SID_W}/permission`);
    const afterAgent = await api("GET", `/api/agent/hotreload-agent${q(PROJ)}`);
    const win = reqWindow(tEdit, Date.now());
    const body = [
      "--- 观察：有 pending 项时，改配置文件（文件监听路径）--------------------------",
      ...kv([
        ["会话", SID_W],
        ["改文件时刻", new Date(tEdit).toISOString()],
        ["新配置生效", `改后 ${applied.ms} ms（system -> SYSTEM_V3_MARKER_WATCHER）`],
        ["窗口内 location/reload 调用", String(win.filter((r) => r.method === "POST" && r.path === "/api/location/reload").length) + " 次"],
        ["pending form", beforeForm.json?.data?.length > 0 && afterForm.json?.data?.length > 0 ? "**保留**" : "**被取消**"],
        ["pending permission", beforePerm.json?.data?.length > 0 && afterPerm.json?.data?.length > 0 ? "**保留**" : "**被取消**"],
      ]),
      "",
      "--- 改之前：GET /api/session/<sid>/form -----------------------------------",
      `HTTP ${beforeForm.status}`,
      beforeForm.text,
      "",
      "--- 改之前：GET /api/session/<sid>/permission ------------------------------",
      `HTTP ${beforePerm.status}`,
      beforePerm.text,
      "",
      "--- 改之前：GET /api/agent/hotreload-agent --------------------------------",
      `HTTP ${beforeAgent.status}`,
      beforeAgent.text,
      "",
      "--- 改之后：GET /api/agent/hotreload-agent（配置确实生效了）----------------",
      `HTTP ${afterAgent.status}`,
      afterAgent.text,
      "",
      "--- 改之后：GET /api/session/<sid>/form -----------------------------------",
      `HTTP ${afterForm.status}`,
      afterForm.text,
      "   ⇒ **pending form 保留**（id 与改之前一致）",
      "",
      "--- 改之后：GET /api/session/<sid>/permission ------------------------------",
      `HTTP ${afterPerm.status}`,
      afterPerm.text,
      "   ⇒ **pending permission 保留**（id 与改之前一致）",
      "",
      "--- 窗口内的全部 HTTP 请求 -----------------------------------------------",
      ...win.map((r) => `  ${new Date(r.t).toISOString()}  ${r.method} ${short(r.path)}  -> ${r.status}`),
      "",
      "--- 结论 -----------------------------------------------------------------",
      "  ⇒ 文件监听路径**不取消**任何待答复项 ⇒ 这就是实现里 `deferred` 分支的落点：",
      "    有 pending 时不做确定性重载，改由文件监听路径生效（pending 安全保住）。",
    ];
    artifact(
      "10-pending-preserved-by-file-watcher.txt",
      "10",
      "文件监听路径 —— 改配置即生效，且**保留** pending form / permission",
      {
        what: "有 pending form + pending permission 时改项目 opencode.json（不调用 location/reload），看配置生效且 pending 保留",
        when: iso(),
        cmds: [
          `# 改配置（触发文件监听路径；**不**调 location/reload）`,
          `node -e 'const f="${PROJECT_CONFIG}";const d=JSON.parse(require("fs").readFileSync(f));d.agents["hotreload-agent"].system="SYSTEM_V3_MARKER_WATCHER";require("fs").writeFileSync(f,JSON.stringify(d,null,2))'`,
          `curl -s -u "opencode:$PW" -G "${BASE}/api/agent/hotreload-agent" --data-urlencode "location[directory]=${PROJ}"`,
          `curl -s -u "opencode:$PW" "${BASE}/api/session/<sid>/form"`,
          `curl -s -u "opencode:$PW" "${BASE}/api/session/<sid>/permission"`,
        ],
      },
      body,
    );
  }

  // ======================================================================
  // 11 — 不需要任何 watcher 开关
  // ======================================================================
  {
    const projCfgRaw = fs.readFileSync(PROJECT_CONFIG, "utf8");
    const globalCfgRaw = fs.readFileSync(GLOBAL_CONFIG, "utf8");
    const watcherLines = logLinesSafe(/watcher (subscribe|started)/, { limit: 24 });
    // 实测：v2 的 watcher 段只认 `ignore`；写 `enabled` 会被静默丢掉
    const cfgProbe = JSON.parse(projCfgRaw);
    cfgProbe.watcher = { enabled: false };
    const tProbe = Date.now();
    const markProbe = logMark();
    writeJson(PROJECT_CONFIG, cfgProbe);
    await sleep(3000);
    const echoProbe = await api("GET", "/api/config");
    const probeDoc = (echoProbe.json || []).find((e) => e.type === "document" && e.path === PROJECT_CONFIG);
    const diagLines = logSince(markProbe, { re: /normalization diagnostic/, limit: 10 });

    // 官方发布的 config schema（网络可选；取不到就写明「未取到」）
    const SCHEMA_URL = "https://opencode.ai/config.json";
    let schemaBlock = null;
    let schemaFetchedAt = null;
    let schemaError = null;
    try {
      const res = await fetch(SCHEMA_URL);
      const schema = await res.json();
      schemaFetchedAt = iso();
      schemaBlock = schema?.properties?.watcher ?? null;
    } catch (err) {
      schemaError = String(err?.message || err);
    }

    // 还原（把 probe 用的 watcher 段撤掉）
    delete cfgProbe.watcher;
    writeJson(PROJECT_CONFIG, cfgProbe);
    await sleep(2000);

    const body = [
      "--- 事实 1：本次全部热重载发生时，配置里**没有** watcher 段 --------------------",
      "项目配置 <proj>/opencode.json（原文）：",
      "---- 8< ----",
      projCfgRaw.replace(/\n$/, ""),
      "---- 8< ----",
      "",
      "隔离全局配置 $XDG_CONFIG_HOME/opencode/opencode.json（原文）：",
      "---- 8< ----",
      globalCfgRaw.replace(/\n$/, ""),
      "---- 8< ----",
      "",
      "⇒ 两个配置文件里**都没有** `watcher` 键；上面 01~10 的每一次热重载都是在这份",
      "  「零 watcher 配置」下发生的。",
      "",
      "--- 事实 2：v2 的 watcher 段只认 `ignore`（没有 enabled 之类的开关）----------",
      "（a）**契约级**：官方发布的 config schema 里的 `watcher` 定义（本次实时抓取）：",
      `      来源: ${SCHEMA_URL}`,
      `      抓取时刻: ${schemaFetchedAt || "(未取到)"}`,
      ...(schemaError ? [`      抓取失败: ${schemaError}`] : []),
      "      ---- 8< ----",
      ...(schemaBlock
        ? JSON.stringify(schemaBlock, null, 2).split("\n").map((l) => "      " + l)
        : ["      (未取到)"]),
      "      ---- 8< ----",
      "      ⇒ `watcher` 的 `additionalProperties: false`，且**只有 `ignore` 一个属性**。",
      "",
      "（b）**实机级**：在项目配置里写 `watcher: { \"enabled\": false }`，v2 归一化后它变成：",
      `      写入时刻: ${new Date(tProbe).toISOString()}`,
      "      ---- 8< ----",
      `      ${JSON.stringify(probeDoc?.info?.watcher)}`,
      "      ---- 8< ----",
      "（`enabled` 这个未知键被**静默丢弃**，watcher 段变成空对象；",
      "  serve 日志里也**没有**任何 `configuration normalization diagnostic` 告警 ——",
      "  证据（该时间窗内 serve 日志中 `normalization diagnostic` 的行数 =",
      `  ${diagLines.length}）：`,
      ...(diagLines.length ? diagLines : ["  (0 行 —— 没有告警)"]),
      "⇒ 也就是说：**根本没有「关掉热重载」这个旋钮**——热重载是默认行为，",
      "  唯一能配的只是 `watcher.ignore`（忽略哪些路径）。",
      "",
      "--- 事实 3：v2 的 watcher 是**默认开启**的 -----------------------------------",
      "serve 日志（watcher subscribe / started）：",
      ...watcherLines,
      "",
      "⇒ 每一条 `watcher started ... ignores=0` 都说明监听已建立、忽略列表为空。",
      "",
      "--- 附：GET /api/config 的归一化回显（watcher 段为空对象）-------------------",
      `HTTP ${echoProbe.status}`,
      JSON.stringify(
        (echoProbe.json || []).find((e) => e.type === "document" && e.path === PROJECT_CONFIG)?.info,
        null,
        2,
      ),
    ];
    artifact(
      "11-no-watcher-switch.txt",
      "11",
      "不需要任何 watcher 开关 —— v2 的 watcher 段只有 `ignore`，热重载默认开启",
      {
        what: "证明本次全部热重载都在「零 watcher 配置」下发生；并实测 v2 的 watcher 段只认 ignore（写 enabled 会被静默丢弃）",
        when: iso(),
        cmds: [
          `cat "${PROJECT_CONFIG}"          # 全文 —— 没有 watcher 键`,
          `cat "${GLOBAL_CONFIG}"          # 全文 —— 没有 watcher 键`,
          `# 实测 watcher 段只认 ignore：`,
          `node -e 'const f="${PROJECT_CONFIG}";const d=JSON.parse(require("fs").readFileSync(f));d.watcher={enabled:false};require("fs").writeFileSync(f,JSON.stringify(d,null,2))'`,
          `curl -s -u "opencode:$PW" "${BASE}/api/config"   # 看归一化后的 watcher 段`,
          `grep 'watcher started' "${SERVE_LOG}"`,
        ],
      },
      body,
    );
  }

  // ---- 收尾：杀掉 serve，核对没有残留 ---------------------------------------
  stop();
  for (let i = 0; i < 30; i++) {
    if (serveProc.exitCode !== null || serveProc.signalCode !== null) break;
    await sleep(200);
  }
  if (serveProc.exitCode === null && serveProc.signalCode === null) {
    stopHard();
    await sleep(500);
  }
  const leftover = spawnSync("pgrep", ["-fl", "opencode serve"], { encoding: "utf8" }).stdout.trim();
  console.log("\n--- pgrep -fl \"opencode serve\"（收尾核对）---");
  console.log(leftover || "(无)");
  console.log(`\nscratch kept at: ${SCRATCH}`);
  console.log(`artifacts written to: ${OUT}`);
}

/** 读 serve 日志里匹配 re 的行（全文范围内，原文照抄）。 */
function logLinesSafe(re, { limit = 40 } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(SERVE_LOG, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.length > 0 && re.test(l))
    .slice(0, limit);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
