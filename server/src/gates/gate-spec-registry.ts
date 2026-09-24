/**
 * 全门禁松紧审计：门禁单测文件清单（plan-finalize-actions todo 5）。
 *
 * todo 1 C3 闭合清单 8 项 → 覆盖单测文件映射（loosen-only 审计范围锁）：
 * 执行门禁 / issue 锁 / 三元组门 / throttle / force / a_plan 豁免 /
 * toolAllows / bash-edit。no-tighten 机器检查（no-tighten-audit.spec.ts）
 * 枚举本清单：删文件即红；放行变拒绝即红（allow 侧行为断言）。
 *
 * 基线（2026-09-16，改前，套件未改动）：
 * server 14 套件 / 165 用例 / 1 快照全绿；
 * worker 2 套件 / 88 用例全绿。改后对比见
 * .omo/evidence/plan-finalize-actions/task-5/audit.json。
 */

/** 门禁单测文件条目：path 以仓库根为基准（server/ 或 worker/ 前缀）。 */
export interface GateSpecEntry {
  /** 仓库根相对路径，如 'server/src/chat/worker-dispatcher.gate.spec.ts'。 */
  file: string;
  /** 覆盖的 C3 门禁项。 */
  gates: string[];
}

/** no-tighten 检查枚举的门禁单测文件清单（共 16 个，删一即红）。 */
export const GATE_SPEC_FILES: GateSpecEntry[] = [
  {
    file: 'server/src/chat/worker-dispatcher.gate.spec.ts',
    gates: ['execution-gate', 'plan-hash', 'a_plan-exemption-removed'],
  },
  {
    file: 'server/src/platform-mcp/platform-mcp.service.gate.spec.ts',
    gates: [
      'execution-gate',
      'plan-hash',
      'issue-lock',
      'force',
      'a_plan-exemption-removed',
    ],
  },
  {
    file: 'server/src/issues/review-round-gate.service.spec.ts',
    gates: ['triplet-gate', 'issue-lock'],
  },
  {
    file: 'server/src/issues/review-round-ledger.spec.ts',
    gates: ['triplet-gate', 'issue-lock'],
  },
  {
    file: 'server/src/chat/review-dispatch-triplet.spec.ts',
    gates: ['triplet-gate'],
  },
  {
    file: 'server/src/platform-mcp/platform-mcp.service.review-dispatch.spec.ts',
    gates: ['triplet-gate'],
  },
  {
    file: 'server/src/chat/mention-throttle.spec.ts',
    gates: ['throttle'],
  },
  {
    file: 'server/src/issues/plan-hash-gate.spec.ts',
    gates: ['execution-gate'],
  },
  {
    file: 'server/src/chat/worker-dispatcher.plan-hash.spec.ts',
    gates: ['execution-gate'],
  },
  {
    file: 'server/src/platform-mcp/platform-mcp.service.plan-hash.spec.ts',
    gates: ['execution-gate', 'force'],
  },
  {
    file: 'server/src/common/constants/agent.constants.spec.ts',
    gates: ['toolAllows'],
  },
  {
    file: 'server/src/execution-policies/agent-policies.matrix.spec.ts',
    gates: ['toolAllows', 'bash-edit'],
  },
  {
    file: 'server/src/execution-policies/agent-policies.controller.spec.ts',
    gates: ['toolAllows', 'bash-edit'],
  },
  {
    file: 'server/src/execution-policies/agent-policies.custom-agents.spec.ts',
    gates: ['toolAllows', 'bash-edit'],
  },
  {
    file: 'server/src/platform-mcp/platform-mcp.tool-permission.spec.ts',
    gates: ['toolAllows'],
  },
];

/** 改前基线（套件未改动时实测）：server 侧。 */
export const SERVER_GATE_BASELINE = {
  suites: 14,
  tests: 165,
  snapshots: 1,
} as const;

/** 改前基线（套件未改动时实测）：worker 侧。 */
export const WORKER_GATE_BASELINE = {
  suites: 2,
  tests: 88,
  snapshots: 0,
} as const;
