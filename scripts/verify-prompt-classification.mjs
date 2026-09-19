#!/usr/bin/env node
/**
 * RETIRED — pre-split classifier for the agent-role-entity plan (todo 2 artifact).
 *
 * This script compared the todo-2 classification against the PRE-SPLIT
 * `server/prisma/seed.ts` (the 7 monolithic prompts). That seed no longer exists:
 * todo 3 lifted the platform blocks and todo 4 moved the role lines into
 * `AgentRole.rolePrompt`, so re-running the original logic today always reports a
 * bogus `TOTAL source 93 != classified 264` + hundreds of `index out of range`
 * errors. It is a dead oracle and MUST NOT be used as a gate (its prior failure mode
 * was a non-advisory printout; in any case its exit code is meaningless post-split).
 *
 * Post-split instruction parity is owned by `scripts/verify-instruction-parity.mjs`
 * (todo 8). This path is kept as a tombstone that DELEGATES to the live checker and
 * propagates its exit code, so a bare invocation can never produce a false pass.
 *
 * Original (pre-split) history: git log -- scripts/verify-prompt-classification.mjs
 *
 * Usage: node scripts/verify-prompt-classification.mjs
 *   (equivalent to: node scripts/verify-instruction-parity.mjs)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = path.join(HERE, 'verify-instruction-parity.mjs');

console.log(
  'RETIRED: verify-prompt-classification.mjs (pre-split oracle) — delegating to scripts/verify-instruction-parity.mjs',
);
const r = spawnSync(process.execPath, [LIVE, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
