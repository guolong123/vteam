/**
 * DSH patch 的 **conformance 断言**（升级闸门）。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────
 * 本仓库对 dsh 做了两类改造，二者都依赖上游的**具体结构**：
 *
 * 1. `scripts/vendor-sdk-server.mjs`：往 SDK server 的 switch 里**文本注入**
 *    `session/create` / `session/cancel` / `session/steer` / `session/selectModel`，
 *    并改 `createSession` 的 meta、订阅 `agent/assistant-stream`；
 * 2. `engine/dsh/patch-builder.ts`：生成 cordis patch（provider 路由 / MCP /
 *    session-controller / system-prompt）。
 *
 * 上游一升级，两类改造都可能**静默失效**：
 * - vendor 脚本有锚点断言（构建期就失败，这个已经有保障）；
 * - **patch 侧没有**。例如 `session/selectModel` 依赖 `sessionController` 服务，
 *   而该服务所在的包**没有被 sdk profile 挂载**（alpha.2 与 rc.5 均如此，实测）
 *   ⇒ `selectModel` 恒失败 ⇒ 驱动「回退重启」仍能换模型，**功能看起来正常**，
 *   只是从"一次 RPC"退化成"重启进程 ~1s + 必须等无在途回合"。
 *   这种降级没有任何报错，只能靠断言钉死。
 *
 * 因此本文件断言的是**patch 的必备条目 + 驱动在 selectModel 可用/不可用时的分野**，
 * 而不是"某段文本存在"这种易碎断言。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DshDriver } from '../../driver/dsh-driver';
import { DshResourceInjector } from './injector';
import { buildDshPatch } from './patch-builder';
import type { EngineConfigSnapshot } from '../types';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function workDirFor(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-conformance-'));
}

function snapshotOf(workDir: string): EngineConfigSnapshot {
  return {
    workDir,
    skills: [],
    tools: [],
    mcpServers: [],
    agentPolicies: [],
    modelCredentials: [
      { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', apiKey: 'k' },
    ],
  };
}

describe('dsh patch conformance：session-controller 必须挂载', () => {
  /**
   * 这一条是**升级闸门**：删掉 patch 里的 session-controller，`selectModel` 就会
   * 恒失败，而驱动会**静默回退**到重启换模型（功能不报错、只变慢）。
   */
  it('buildDshPatch 产物包含 session-controller（insert 形态）', () => {
    const patch = buildDshPatch({ providers: [], mcpMounts: [] });

    expect(patch).toContain('- insert:');
    expect(patch).toContain('- id: session-controller');
    expect(patch).toContain("name: '@deepseek-ai/dsh-api-session-controller'");
  });

  it('session-controller 不依赖 providers/mcp —— 空快照也必须带上', () => {
    // 启动早期（凭据/目录/MCP 都还没拉到）就会写第一版 patch；此时若漏了它，
    // 首次会话仍然换不动模型，且没有任何日志指向 patch。
    const patch = buildDshPatch({ providers: [], mcpMounts: [] });
    const idx = patch.indexOf('- id: session-controller');
    expect(idx).toBeGreaterThan(-1);
    // 必须位于自己的 insert: 块里（平铺会被 dsh 当成"修改已有 id"并静默跳过）
    const before = patch.slice(0, idx);
    expect(before.lastIndexOf('- insert:')).toBeGreaterThan(
      before.lastIndexOf('- id: system-prompt'),
    );
  });

  it('注入器实际写出的 patch 文件里也存在（防止夹具与真实产物漂移）', async () => {
    const workDir = workDirFor();
    const injector = new DshResourceInjector({ logger: silent });
    await injector.apply(snapshotOf(workDir), workDir);

    const content = fs.readFileSync(
      path.join(workDir, '.vteam', 'dsh-profile.patch.yml'),
      'utf8',
    );
    expect(content).toContain("name: '@deepseek-ai/dsh-api-session-controller'");
  });
});

describe('dsh 驱动：selectModel 可用 vs 不可用必须可区分', () => {
  /** 造一个带会话、运行时在跑的驱动（mock RPC）。 */
  function makeDriver(requestImpl: (method: string) => Promise<unknown>) {
    const driver = new DshDriver({ provider: 'p-old', model: 'm-old', logger: silent });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDriver = driver as any;
    const close = jest.fn(async () => undefined);
    const request = jest.fn(async (method: string) => requestImpl(method));
    anyDriver.client = { isRunning: true, initialized: true, request, close };
    anyDriver.sessions.set('s1', anyDriver.newMirror('s1'));
    return { driver, anyDriver, close, request };
  }

  it('selectModel 成功 → 运行期生效，**不重启**（这是 patch 挂对时的行为）', async () => {
    const { driver, close, request } = makeDriver(async () => ({ selected: {} }));
    await driver.ensureModel({ providerID: 'p-new', modelID: 'm-new' });

    expect(request).toHaveBeenCalledWith(
      'session/selectModel',
      { sessionId: 's1', provider: 'p-new', model: 'm-new' },
      15_000,
    );
    expect(close).not.toHaveBeenCalled();
  });

  /**
   * 这一条描述**缺 session-controller 时的真实后果**（不是理论）。
   *
   * ⚠️ 它有意断言"回退重启"是**兜底**而非常态：只要 patch 里的
   * session-controller 还在（上一条 describe 已钉死），这条路径就不该被走到。
   * 若哪天它变成常态，日志里会出现「selectModel 全部失败 … 回退重启运行时」。
   */
  it('selectModel 报 service unavailable → 回退重启（兜底路径，必须留日志线索）', async () => {
    const { driver, close } = makeDriver(async (method: string) => {
      if (method === 'session/selectModel') {
        throw new Error('sessionController service unavailable');
      }
      return {};
    });

    await driver.ensureModel({ providerID: 'p-new', modelID: 'm-new' });

    // 兜底路径必须关运行时（下次 spawn 用新路由握手）
    expect(close).toHaveBeenCalled();
  });
});
