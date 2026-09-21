/**
 * todo 9 (b) — diff the BEFORE/AFTER captures into the closing matrix.
 *
 *   node matrix.mjs
 *
 * Assertion model: every member row that exists on BOTH sides must be identical on the
 * four proof values plus the two migrated consumers, field-level (not just "no crash"):
 *   policyId / policyName / agentName / 4 digests / suppression booleans,
 *   policyCandidate, planDuty, issueDetail, derivedAlias.
 * A row present on only one side is a failure, not a skip.
 */
import { readFileSync, writeFileSync } from 'node:fs';
const D = '/Volumes/SSD-Data/01work/git-project/vteam/.omo/evidence/agent-role-decommission/task-9';
const before = JSON.parse(readFileSync(`${D}/before.json`, 'utf8'));
const after = JSON.parse(readFileSync(`${D}/after.json`, 'utf8'));

const k = (r) => `${r.teamId}|${r.memberId}`;
const bMap = new Map(before.members.map((r) => [k(r), r]));
const aMap = new Map(after.members.map((r) => [k(r), r]));
const problems = [];
const memberRows = [];

for (const [key, aft] of aMap) {
  const bef = bMap.get(key);
  if (!bef) { problems.push(`member ${key} present AFTER but absent BEFORE`); continue; }
  const cmp = {
    policyId: bef.policy?.policyId === aft.policy?.policyId,
    policyName: bef.policy?.policyName === aft.policy?.policyName,
    agentName: bef.policy?.agentName === aft.policy?.agentName,
    toolsDigest: bef.policy?.toolsDigest === aft.policy?.toolsDigest,
    permissionDigest: bef.policy?.permissionDigest === aft.policy?.permissionDigest,
    correctionDigest: bef.policy?.correctionDigest === aft.policy?.correctionDigest,
    bashDenyDigest: bef.policy?.bashDenyDigest === aft.policy?.bashDenyDigest,
    memorySuppressed: bef.policy?.memorySectionSuppressed === aft.policy?.memorySectionSuppressed,
    artifactSuppressed: bef.policy?.artifactSectionSuppressed === aft.policy?.artifactSectionSuppressed,
    policyCandidate: bef.policyCandidate === aft.policyCandidate,
    planDuty: bef.planDuty === aft.planDuty,
    issueDetail: bef.issueDetail === aft.issueDetail,
    derivedAlias: bef.derivedAlias === aft.derivedAlias,
  };
  const failed = Object.entries(cmp).filter(([, v]) => !v).map(([f]) => f);
  const seeded = aft.memberId !== 'tmm_t9_analyst';
  if (failed.length && seeded) {
    problems.push(`SEEDED member ${key} (${aft.agentId}): differs on ${failed.join(',')}`);
  }
  memberRows.push({ key, seeded, bef, aft, cmp, allIdentical: failed.length === 0 });
}
for (const key of bMap.keys()) if (!aMap.has(key)) problems.push(`member ${key} present BEFORE but absent AFTER`);

const aAg = new Map(after.agents.map((r) => [r.agentId, r]));
const bAg = new Map(before.agents.map((r) => [r.agentId, r]));
const agentRows = [];
for (const [id, aft] of aAg) {
  const bef = bAg.get(id);
  if (!bef) { problems.push(`agent ${id} only AFTER`); continue; }
  const cmp = {
    policy: JSON.stringify(bef.policy) === JSON.stringify(aft.policy),
    policyCandidate: bef.policyCandidate === aft.policyCandidate,
    planDuty: bef.planDuty === aft.planDuty,
    issueDetail: bef.issueDetail === aft.issueDetail,
  };
  const failed = Object.entries(cmp).filter(([, v]) => !v).map(([f]) => f);
  if (failed.length) problems.push(`agent ${id} (${aft.agentKey}): differs on ${failed.join(',')}`);
  agentRows.push({ id, bef, aft, cmp, allIdentical: failed.length === 0 });
}
for (const id of bAg.keys()) if (!aAg.has(id)) problems.push(`agent ${id} only BEFORE`);

const aT = new Map(after.teams.map((r) => [r.teamId, r]));
const bT = new Map(before.teams.map((r) => [r.teamId, r]));
const teamRows = [];
for (const [id, aft] of aT) {
  const bef = bT.get(id);
  if (!bef) { problems.push(`team ${id} only AFTER`); continue; }
  const cmp = {
    mainMemberId: bef.mainMemberId === aft.mainMemberId,
    mainPlanDuty: bef.mainPlanDuty === aft.mainPlanDuty,
    effectivePlanDutyDisjunct: bef.effectivePlanDutyDisjunct === aft.effectivePlanDutyDisjunct,
  };
  const failed = Object.entries(cmp).filter(([, v]) => !v).map(([f]) => f);
  if (failed.length) problems.push(`team ${id}: differs on ${failed.join(',')}`);
  teamRows.push({ id, bef, aft, cmp, allIdentical: failed.length === 0 });
}
for (const id of bT.keys()) if (!aT.has(id)) problems.push(`team ${id} only BEFORE`);

const aliasMismatch = memberRows.filter((r) => r.seeded && !r.aft.aliasMatchesStored);

const matrix = {
  generatedAt: new Date().toISOString(),
  beforeSource: before.sourceRoot, afterSource: after.sourceRoot,
  beforeCounts: before.counts, afterCounts: after.counts,
  members: memberRows, agents: agentRows, teams: teamRows,
  summary: {
    membersIdentical: memberRows.filter((r) => r.allIdentical).length, membersTotal: memberRows.length,
    seededMembersIdentical: memberRows.filter((r) => r.seeded && r.allIdentical).length,
    seededMembersTotal: memberRows.filter((r) => r.seeded).length,
    injectedRows: memberRows.filter((r) => !r.seeded).map((r) => ({ key: r.key, identical: r.allIdentical, failed: Object.entries(r.cmp).filter(([, v]) => !v).map(([f]) => f) })),
    agentsIdentical: agentRows.filter((r) => r.allIdentical).length, agentsTotal: agentRows.length,
    teamsIdentical: teamRows.filter((r) => r.allIdentical).length, teamsTotal: teamRows.length,
    storedAliasMismatches: aliasMismatch.map((r) => r.key),
    problems,
  },
};
writeFileSync(`${D}/matrix.json`, JSON.stringify(matrix, null, 2) + '\n');

const L = [];
L.push(`BEFORE=${before.sourceRoot} (pre-drop DB: ${before.counts.members} members / ${before.counts.agents} agents / ${before.counts.teams} teams)`);
L.push(`AFTER =${after.sourceRoot} (migrated DB: ${after.counts.members} members / ${after.counts.agents} agents / ${after.counts.teams} teams)`);
L.push('');
L.push('== PER-MEMBER BEFORE -> AFTER (4 proof values + 2 migrated consumers) ==');
L.push('(the `seeded` column is YES for the 28 members restored from the pre-drop dump; the one NO row is the'); 
L.push(' inject.sql custom-role member, reported separately at the end)');
L.push('seeded | member | team | agent | role(before) | policyId | opencodeAgent | planDuty | issueDetail | memorySupp | artifactSupp | alias | all-identical');
for (const r of memberRows) {
  L.push([
    r.seeded ? 'YES' : 'NO', r.key, r.aft.agentId, r.aft.historicalRole ?? '<null>',
    r.aft.policy?.policyId ?? '<null>',
    `${r.bef.policyCandidate ?? '<none>'} -> ${r.aft.policyCandidate ?? '<none>'}`,
    `${r.bef.planDuty} -> ${r.aft.planDuty}`,
    `${r.bef.issueDetail} -> ${r.aft.issueDetail}`,
    `${r.bef.policy?.memorySectionSuppressed} -> ${r.aft.policy?.memorySectionSuppressed}`,
    `${r.bef.policy?.artifactSectionSuppressed} -> ${r.aft.policy?.artifactSectionSuppressed}`,
    `${r.bef.derivedAlias} -> ${r.aft.derivedAlias} (stored=${r.aft.storedAlias})`,
    r.allIdentical ? 'YES' : `NO ${JSON.stringify(Object.fromEntries(Object.entries(r.cmp).filter(([, v]) => !v)))}`,
  ].join(' | '));
}
L.push('');
L.push('== PER-AGENT ==');
for (const r of agentRows) {
  L.push([
    r.id, r.aft.agentKey ?? '<null>', r.aft.historicalRole ?? '<null>', r.aft.policy?.policyId ?? '<null>',
    `${r.bef.policyCandidate ?? '<none>'} -> ${r.aft.policyCandidate ?? '<none>'}`,
    `${r.bef.planDuty} -> ${r.aft.planDuty}`,
    `issueDetail ${r.bef.issueDetail} -> ${r.aft.issueDetail}`,
    r.allIdentical ? 'YES' : `NO ${JSON.stringify(Object.fromEntries(Object.entries(r.cmp).filter(([, v]) => !v)))}`,
  ].join(' | '));
}
L.push('');
L.push('== PER-TEAM plan-mode decision (duty disjunct; identical expression both sides) ==');
for (const r of teamRows) {
  L.push([r.id, `mainMember=${r.aft.mainMemberId ?? '<null>'}`, `mainAgentKey=${r.aft.mainAgentKey ?? '<null>'}`,
    `opencodeAgent=${r.aft.mainOpencodeAgentName ?? '<null>'}`, `mainDuty=${r.aft.mainPlanDuty}`,
    `effectivePlanDisjunct=${r.aft.effectivePlanDutyDisjunct}`,
    r.allIdentical ? 'YES' : `NO ${JSON.stringify(Object.fromEntries(Object.entries(r.cmp).filter(([, v]) => !v)))}`].join(' | '));
}
L.push('');
L.push(`SUMMARY rows ${matrix.summary.membersIdentical}/${matrix.summary.membersTotal} identical | SEEDED members ${matrix.summary.seededMembersIdentical}/${matrix.summary.seededMembersTotal} identical (acceptance) | agents ${matrix.summary.agentsIdentical}/${matrix.summary.agentsTotal} | teams ${matrix.summary.teamsIdentical}/${matrix.summary.teamsTotal}`);
for (const inj of matrix.summary.injectedRows) {
  L.push(`INJECTED-ROW ${inj.key}: identical=${inj.identical}${inj.identical ? '' : ' differs-on=' + inj.failed.join(',')}`);
}
L.push(`stored-alias mismatches: ${aliasMismatch.length ? aliasMismatch.map((r) => r.key).join(',') : 'NONE'}`);
L.push(`PROBLEMS: ${problems.length ? '\n  - ' + problems.join('\n  - ') : 'NONE'}`);
writeFileSync(`${D}/matrix.txt`, L.join('\n') + '\n');
console.log(L.join('\n'));
process.exit(problems.length ? 1 : 0);
