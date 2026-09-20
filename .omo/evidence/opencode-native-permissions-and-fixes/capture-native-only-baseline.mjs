/**
 * Baseline capture harness (opencode-native-permissions-and-fixes todo 4).
 *
 * Captures the post-change serialized output of
 * `ExecutionPolicyService.buildAgentPolicies()` (constant path, empty prisma stub):
 * `agents[].permission` carries ONLY opencode-native keys (edit/read/bash/task);
 * `guard.roles[*]` is unchanged (still carries permission/tools/bashDeny/correction).
 *
 * Deterministic by construction (no DB): the emitted key order is the service's own
 * canonical order, which is what the byte-identity specs compare with
 * `JSON.stringify`. The live `/agent-policies` payload is compared to this artifact
 * canonically (sort_keys) in the e2e harness — MySQL reorders JSON object keys.
 *
 * Read-only with respect to product code and DB — no prisma connection is opened.
 *
 * Usage (from anywhere; node >= 22 with ts-node installed in server/):
 *   node capture-native-only-baseline.mjs
 *
 * Output (next to this script):
 *   baseline-agent-policies.json
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '../../../server');
const serverRequire = createRequire(join(SERVER_ROOT, 'package.json'));

serverRequire('ts-node').register({
  transpileOnly: true,
  project: join(SERVER_ROOT, 'tsconfig.json'),
  compilerOptions: {
    module: 'commonjs',
    target: 'ES2021',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
  },
});
serverRequire('reflect-metadata');

const { ExecutionPolicyService } = serverRequire(
  join(SERVER_ROOT, 'src/execution-policies/execution-policy.service.ts'),
);

const prismaStub = {
  agent: { findMany: async () => [] },
  executionPolicy: { findMany: async () => [] },
};
const policies = await new ExecutionPolicyService(
  prismaStub,
  {},
  { broadcastCommand: async () => 0 },
).buildAgentPolicies();

if (policies.agents.length !== 7 || Object.keys(policies.guard.roles).length !== 7) {
  throw new Error(
    `expected 7 agents + 7 guard roles, got ${policies.agents.length} + ${
      Object.keys(policies.guard.roles).length
    }`,
  );
}
const offenders = policies.agents
  .flatMap((a) => Object.keys(a.permission).map((k) => [a.name, k]))
  .filter(([, k]) => k.startsWith('vteam_'));
if (offenders.length > 0) {
  throw new Error(`agents[].permission still carries vteam_ keys: ${JSON.stringify(offenders)}`);
}
for (const key of ['edit', 'read', 'bash', 'task']) {
  if (!policies.agents.every((a) => key in a.permission)) {
    throw new Error(`agents[].permission lost native key ${key}`);
  }
}

const outPath = join(HERE, 'baseline-agent-policies.json');
const body = JSON.stringify(policies, null, 2) + '\n';
writeFileSync(outPath, body);
const sha = createHash('sha256').update(readFileSync(outPath)).digest('hex');

console.log('agents:', policies.agents.map((a) => a.name).join(', '));
console.log(
  'agents[].permission keys:',
  policies.agents.map((a) => `${a.name}=[${Object.keys(a.permission).join(',')}]`).join(' '),
);
console.log(
  'guard.roles[*] keys:',
  policies.agents.map((a) => `${a.name}=[${Object.keys(policies.guard.roles[a.name]).join(',')}]`).join(' '),
);
console.log('artifact:', outPath);
console.log('sha256:', sha);
