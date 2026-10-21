/**
 * T21 离线形状校验夹具生成器（§3：四个 e2e 证明脚本的**形状逻辑**离线可跑部分）。
 *
 * 产出（写进 --out 目录）：
 * - `opencode.json`：**真实 worker 注入器**写出的 v2 形注入配置（`agents` 节 +
 *   `permissions[]` 有序数组 + `mcp.servers` + `plugins`）；
 * - `source-constants.json`：脚本 step 0 那份「从运行中 server 的编译产物读」的常量
 *   （这里从**源码常量**读同样的值：角色 allowlist / MCP 工具名 / 原生权限键集）；
 * - `endpoint.json`：`GET /agents` 形状（受管角色 + 外部角色），供泄漏检查器用；
 * - `externals.json`：外部 agent 名清单（泄漏检查器的「外部名字」来源）；
 * - 若干**漂移夹具**（drift-*.json）：故意破坏 v2 形状的变体，用来证明形状检查器
 *   **会响亮失败**（而不是空过）。
 *
 * 注入配置由**真实 worker 注入器**产出（`ResourceInjector.applyMcpAndAgents`），
 * 策略由**真实控制面常量**派生（`resolveBuiltinPolicy` + `projectNativePermission`，
 * 与 `buildAgentPolicies()` 无 DB 行时的产出同形）⇒ 夹具不是手搓的。
 *
 * 用法（server 包内跑，server 的 node_modules 才能解析 @nestjs/@prisma）：
 *   cd server && npx ts-node --transpile-only ../scripts/e2e-v2-shape-fixture.ts --out <dir>
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ROLE_BOUNDARIES,
  VTEAM_MCP_TOOL_NAMES,
} from '../server/src/common/constants/agent.constants';
import {
  NATIVE_PERMISSION_KEYS,
  projectNativePermission,
  resolveBuiltinPolicy,
} from '../server/src/execution-policies/execution-policy.service';
import { ResourceInjector } from '../worker/src/resources/injector';

const BUILTIN_ORDER = [
  'vteam-plan',
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-librarian',
] as const;

function parseArgs(argv: string[]): { out: string } {
  const index = argv.indexOf('--out');
  const out = index >= 0 ? argv[index + 1] : path.join(os.tmpdir(), 'vteam-shape-fixture');
  if (!out) {
    throw new Error('缺少 --out <dir>');
  }
  return { out: path.resolve(out) };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(out, { recursive: true });

  // 控制面下发的 /agent-policies 载荷（内置 7 项；无 DB 行时的常量派生形态）。
  const agents = BUILTIN_ORDER.map((name) => {
    const policy = resolveBuiltinPolicy(name, null);
    return {
      name,
      description: policy.description,
      mode: policy.mode,
      permission: projectNativePermission(policy.permission),
    };
  });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-shape-workdir-'));
  const injector = new ResourceInjector({
    serverUrl: 'http://127.0.0.1:1',
    workerToken: 'fixture-token',
    workerId: 'w_fixture',
    workDir,
    logger: { info: () => undefined, warn: () => undefined },
  });
  await injector.applyMcpAndAgents([], { agents });
  const injectedPath = path.join(workDir, 'opencode.json');
  const injected = JSON.parse(fs.readFileSync(injectedPath, 'utf8')) as Record<
    string,
    unknown
  >;

  fs.writeFileSync(
    path.join(out, 'opencode.json'),
    JSON.stringify(injected, null, 2),
    'utf8',
  );

  // step 0 那份「源码常量」JSON（脚本里从运行中 server 的 dist 读；离线读源码常量）。
  const roles: Record<string, string[]> = {};
  for (const name of BUILTIN_ORDER) {
    roles[name] = Object.keys(ROLE_BOUNDARIES[name].toolAllows);
  }
  fs.writeFileSync(
    path.join(out, 'source-constants.json'),
    JSON.stringify(
      {
        mcpToolNames: VTEAM_MCP_TOOL_NAMES,
        gitToolNames: [],
        browserToolNames: [],
        retiredServerGated: [],
        roles,
        nativePermissionKeys: [...NATIVE_PERMISSION_KEYS],
      },
      null,
      2,
    ),
    'utf8',
  );

  // GET /agents 形状（受管 + 外部）：泄漏检查器用它区分「agent 名槽位」。
  const externalNames = ['plan', 'build', 'general'];
  fs.writeFileSync(
    path.join(out, 'endpoint.json'),
    JSON.stringify(
      {
        agents: [
          ...BUILTIN_ORDER.map((name) => ({
            name,
            governed: true,
          })),
          ...externalNames.map((name) => ({ name, governed: false })),
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(out, 'externals.json'),
    JSON.stringify(externalNames, null, 2),
    'utf8',
  );

  // ---- 漂移夹具：故意破坏 v2 形状 ⇒ 形状检查器必须响亮失败（证明它们不是空过）。
  const clone = (): Record<string, any> => JSON.parse(JSON.stringify(injected));
  const agentsOf = (doc: Record<string, any>): Record<string, any> =>
    doc.agents as Record<string, any>;
  const write = (name: string, doc: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(out, name), JSON.stringify(doc, null, 2), 'utf8');
  };

  const drift: Record<string, Record<string, unknown>> = {};

  // ① 只有 v1 `agent` 段（无 `agents`）⇒ v2 段缺失
  {
    const doc = clone();
    doc.agent = doc.agents;
    delete doc.agents;
    drift['drift-legacy-agent-section.json'] = doc;
  }
  // ② 完全没有 agents 段
  {
    const doc = clone();
    delete doc.agents;
    drift['drift-no-agents-section.json'] = doc;
  }
  // ③ 出现 vteam_* action（控制面投影本应剔除）
  {
    const doc = clone();
    agentsOf(doc)['vteam-plan'].permissions.push({
      action: 'vteam_my_profile',
      resource: '*',
      effect: 'allow',
    });
    drift['drift-vteam-action.json'] = doc;
  }
  // ④ 缺 subagent 规则（v1 task 的 v2 名）
  {
    const doc = clone();
    const rules = agentsOf(doc)['vteam-developer'].permissions as Array<
      Record<string, string>
    >;
    agentsOf(doc)['vteam-developer'].permissions = rules.filter(
      (r) => r.action !== 'subagent',
    );
    drift['drift-missing-subagent.json'] = doc;
  }
  // ⑤ 残留 v1 的 bash action
  {
    const doc = clone();
    const rules = agentsOf(doc)['vteam-tester'].permissions as Array<
      Record<string, string>
    >;
    for (const rule of rules) {
      if (rule.action === 'shell') {
        rule.action = 'bash';
      }
    }
    drift['drift-legacy-bash-action.json'] = doc;
  }
  // ⑥ edit 的 '*' 规则被翻成 allow（写闸门默认关被打开）
  {
    const doc = clone();
    const rules = agentsOf(doc)['vteam-architect'].permissions as Array<
      Record<string, string>
    >;
    for (const rule of rules) {
      if (rule.action === 'edit' && rule.resource === '*') {
        rule.effect = 'allow';
      }
    }
    drift['drift-edit-allow.json'] = doc;
  }
  // ⑦ edit 规则不是 deny-then-allow（顺序即优先级）
  {
    const doc = clone();
    const entry = agentsOf(doc)['vteam-developer'];
    const rules = entry.permissions as Array<Record<string, string>>;
    const denyIdx = rules.findIndex(
      (r) => r.action === 'edit' && r.resource === '*' && r.effect === 'deny',
    );
    const allowIdx = rules.findIndex(
      (r) => r.action === 'edit' && r.resource !== '*',
    );
    if (denyIdx >= 0 && allowIdx >= 0) {
      const [denyRule] = rules.splice(denyIdx, 1);
      rules.splice(allowIdx, 0, denyRule);
    }
    drift['drift-edit-order.json'] = doc;
  }
  // ⑧ 缺 external_directory（worker 补的 ask 规则）
  {
    const doc = clone();
    const rules = agentsOf(doc)['vteam-librarian'].permissions as Array<
      Record<string, string>
    >;
    agentsOf(doc)['vteam-librarian'].permissions = rules.filter(
      (r) => r.action !== 'external_directory',
    );
    drift['drift-no-external-directory.json'] = doc;
  }
  // ⑨ 出现 v2 不存在的 write action（第二道写闸门）
  {
    const doc = clone();
    agentsOf(doc)['vteam-product'].permissions.push({
      action: 'write',
      resource: '*',
      effect: 'deny',
    });
    drift['drift-write-action.json'] = doc;
  }
  // ⑩ 少一个内置角色
  {
    const doc = clone();
    delete agentsOf(doc)['vteam-tester'];
    drift['drift-missing-role.json'] = doc;
  }
  // ⑪ 外部名字出现在 agent 名槽位（泄漏夹具）
  {
    const doc = clone();
    agentsOf(doc)['plan'] = agentsOf(doc)['vteam-plan'];
    drift['drift-external-name-slot.json'] = doc;
  }
  // ⑫ vteam-product 的 edit 规则缺探针 glob（native-edit 脚本的 4a 断言用）
  {
    const doc = clone();
    const rules = agentsOf(doc)['vteam-product'].permissions as Array<
      Record<string, string>
    >;
    agentsOf(doc)['vteam-product'].permissions = rules.filter(
      (r) => !(r.action === 'edit' && r.resource === 'src/probe/**'),
    );
    drift['drift-edit-probe-missing.json'] = doc;
  }
  // ⑬ 带探针 glob 的**正确**变体（native-edit 脚本的 4a 断言的正例）
  {
    const doc = clone();
    agentsOf(doc)['vteam-product'].permissions.push({
      action: 'edit',
      resource: 'src/probe/**',
      effect: 'allow',
    });
    drift['ok-edit-probe-present.json'] = doc;
  }

  for (const [name, doc] of Object.entries(drift)) {
    write(name, doc);
  }

  fs.rmSync(workDir, { recursive: true, force: true });
  process.stdout.write(
    `fixture written: ${out} (injected agents=${Object.keys(agentsOf(injected)).length}, drift fixtures=${Object.keys(drift).length})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(String((err as Error).stack ?? err) + '\n');
  process.exit(1);
});
