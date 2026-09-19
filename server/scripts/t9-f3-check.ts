/**
 * todo 9 evidence probe — re-runs F3's duplication check against LIVE DB values.
 *
 * Reproduces F3's method (`f3-qa/role-agent-dedup-populated-db.txt` +
 * `assembled-all7-populated-db.txt`): for each of the 7 builtin template agents, take a
 * captured `agents.prompt` + the bound `agent_roles.role_prompt`, assemble via the REAL
 * `buildSystemInstructions`, count the role/agent/platform blocks, and sentence-de-dup the
 * agent prompt against the role prompt.
 *
 * Usage:
 *   ts-node scripts/t9-f3-check.ts <post.json> [pre.json]
 * where each JSON is [{id, prompt, rolePrompt}] dumped from the live DB (dump command in
 * `.omo/evidence/agent-role-entity/task-9-agent-prompt-backfill.txt`).
 * Omitting [pre.json] reports only the post-migration state.
 *
 * Exits non-zero if the post-migration state has any duplicated block or shared sentence.
 */
import { readFileSync } from 'node:fs';
import { buildSystemInstructions } from '../src/chat/worker-dispatcher';
import { BUILTIN_ROLE_PROMPTS } from '../src/common/constants/agent-role-prompts.constants';

interface LiveRow {
  id: string;
  prompt: string;
  rolePrompt: string;
}

const ROLES: Record<string, string> = {
  a_product: 'product',
  a_project_manager: 'project_manager',
  a_architect: 'architect',
  a_developer: 'developer',
  a_tester: 'tester',
  a_plan: 'plan',
  a_librarian: 'librarian',
};

/** Sentence slice identical to `seed.spec.ts`: newline / 。/ ；, strip md prefix, keep len>=8. */
const splitSentences = (text: string): string[] =>
  text
    .split(/[\n。；]/)
    .map((s) => s.trim().replace(/^[-#\s]+/, '').trim())
    .filter((s) => s.length >= 8);

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

function analyze(
  label: string,
  rows: { id: string; role: string; prompt: string; rolePrompt: string }[],
) {
  const agents: Record<string, unknown>[] = [];
  let totalShared = 0;
  for (const row of rows) {
    const assembled = buildSystemInstructions(
      {
        id: row.id,
        name: null,
        role: row.role,
        prompt: row.prompt,
        persona: null,
        agentKey: row.role,
        policyId: null,
      },
      { rolePrompt: row.rolePrompt },
    );
    const counts = {
      roleHeading: countOccurrences(assembled, '【岗位职责】'),
      agentHeading: countOccurrences(assembled, '【职责】'),
      identity: countOccurrences(assembled, '# 角色：'),
      charter: countOccurrences(assembled, '团队协作规约（全文见'),
      receipt: countOccurrences(assembled, '回执铁律'),
    };
    const roleSents = new Set(splitSentences(row.rolePrompt));
    const shared = splitSentences(row.prompt).filter((s) => roleSents.has(s));
    totalShared += shared.length;
    const idxRole = assembled.indexOf('【岗位职责】');
    const idxAgent = assembled.indexOf('【职责】');
    const idxCharter = assembled.indexOf('团队协作规约（全文见');
    const idxReceipt = assembled.indexOf('回执铁律');
    const ordered =
      idxRole >= 0 &&
      idxAgent > idxRole &&
      idxCharter > idxAgent &&
      idxReceipt > idxCharter;
    const duplicated =
      counts.roleHeading !== 1 ||
      counts.agentHeading !== 1 ||
      counts.charter !== 1 ||
      counts.receipt !== 1 ||
      shared.length > 0;
    agents.push({
      id: row.id,
      agentPromptLen: row.prompt.length,
      rolePromptLen: row.rolePrompt.length,
      counts,
      order: { idxRole, idxAgent, idxCharter, idxReceipt, ordered },
      sharedSentences: shared.length,
      duplicated,
    });
  }
  return {
    label,
    agents,
    totalSharedSentences: totalShared,
    builtinsWithDuplicatedBlocks: agents.filter((a) => a.duplicated).length,
  };
}

const toRows = (rows: LiveRow[]) =>
  rows.map((r) => ({
    id: r.id,
    role: ROLES[r.id],
    prompt: r.prompt,
    rolePrompt: r.rolePrompt,
  }));

const post: LiveRow[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const before: LiveRow[] | null = process.argv[3]
  ? JSON.parse(readFileSync(process.argv[3], 'utf8'))
  : null;

const rolePromptByteEqualVsConstants: Record<string, boolean> = {};
for (const r of post) {
  rolePromptByteEqualVsConstants[r.id] =
    r.rolePrompt === BUILTIN_ROLE_PROMPTS[ROLES[r.id]];
}

const afterAnalysis = analyze('AFTER (post-migration agents.prompt)', toRows(post));
console.log(
  JSON.stringify(
    {
      rolePromptByteEqualVsConstants,
      ...(before
        ? { before: analyze('BEFORE (pre-split agents.prompt)', toRows(before)) }
        : {}),
      after: afterAnalysis,
    },
    null,
    2,
  ),
);

if (
  afterAnalysis.builtinsWithDuplicatedBlocks !== 0 ||
  afterAnalysis.totalSharedSentences !== 0
) {
  process.exit(1);
}
