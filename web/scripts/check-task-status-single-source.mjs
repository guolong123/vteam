#!/usr/bin/env node
/**
 * check-task-status-single-source.mjs — TaskApiStatus 单一来源 guard（tech-debt-remediation Todo 17）。
 * ============================================================================
 * Todo 14 将 web 侧 5 处重复 `type TaskApiStatus` 收敛到唯一定义
 * `web/src/types/task-status.ts`；本检查保证第二处声明一旦重现就让构建失败。
 *
 * 规则：web/src + web/app 下匹配 /^\s*(export\s+)?type\s+TaskApiStatus\s*=/ 的
 * 声明行必须恰好 1 处（即 task-status.ts:12）。`export type { TaskApiStatus }`
 * 重导出与 `import type { TaskApiStatus }` 导入不含 `type TaskApiStatus =`，
 * 不计入，刻意保持 Todo 14 的 grep 口径一致。
 *
 * 零依赖（仅 node:fs/node:path），无 codegen，不写任何文件。
 * 接线：web/package.json `prebuild`，`npm run build` 自动先跑本检查。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const roots = [join(webRoot, "src"), join(webRoot, "app")];
const DECL_RE = /^\s*(export\s+)?type\s+TaskApiStatus\s*=/;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
}

const files = [];
for (const r of roots) walk(r, files);

const hits = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (DECL_RE.test(line)) {
      hits.push(`${relative(webRoot, f)}:${i + 1}:${line.trim()}`);
    }
  });
}

if (hits.length !== 1) {
  console.error(
    `[check-task-status-single-source] FAIL: expected exactly 1 \`type TaskApiStatus =\` declaration (web/src/types/task-status.ts), found ${hits.length}:`,
  );
  for (const h of hits) console.error(`  - ${h}`);
  console.error(
    "Fix: import from \"@/src/types/task-status\" instead of re-declaring the union.",
  );
  process.exit(1);
}

console.log(`[check-task-status-single-source] OK: single declaration → ${hits[0]}`);
