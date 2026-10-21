/**
 * D6 候选 (f)：逐消息 system blob 的**插件交接**单元测试。
 *
 * 覆盖四组事实：
 * 1. **插件模块形态**：与既有生成器（custom-tool / git-tools / browser-tools）同口径
 *    （`Plugin.define` + 动态 import + identity 兜底 + `setup` 防呆 + 中文注释）；
 * 2. **插件行为**：把渲染出的模块**真的求值**（vm 里跑）→ `context` hook 把 blob 推进
 *    system 段；没有交接文件时 **no-op**（不推空段）；
 * 3. **交接通道语义**：写一次、读多次（逐字节稳定）、原子写、清目录、有界、失败降级；
 * 4. **协商**：插件文件在位 / 就绪标记在位 两种事实的判定，以及"未就绪 ⇒ 不交付"。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import {
  HANDOFF_SESSION_ID_RE,
  SYSTEM_HANDOFF_DIR_NAME,
  SYSTEM_HANDOFF_MAX_ENTRIES,
  SYSTEM_HANDOFF_PLUGIN_FILE,
  SYSTEM_HANDOFF_PLUGIN_ID,
  SystemHandoffStore,
  installSystemHandoffPlugin,
  locationHash,
  renderSystemHandoffPlugin,
  resolveSystemHandoffDir,
  resolveSystemHandoffFile,
} from './v2-system-handoff';

const BLOB = '【平台协议】产出物协议\n【岗位职责】你是开发工程师\n【记忆规则】只发增量';
/** 假 location（插件 `setup` 写就绪标记时用它）。 */
const LOCATION = '/data/vteam-worker/teams/tm_0000000001';

function tempWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-handoff-'));
}

/**
 * 把渲染出的插件模块**真的求值**（绕开 ESM 顶层 await 与 `@opencode/plugin` 依赖）：
 * 用仓库自带的 TypeScript 编译器把产物转成 ESNext JS，再去掉 import 行、
 * 把动态 import 换成 identity 兜底、`export default` 换成 `module.exports`。
 */
function evaluatePluginModule(source: string): {
  setup: (ctx: unknown) => Promise<void>;
  id: string;
} {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const transformed = transpiled
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n')
    .replace(
      /const \{ Plugin \} = \(await import[\s\S]*?\}\)\)\)/,
      'const Plugin = { define: (plugin) => plugin }',
    )
    .replace('export default {', 'module.exports = {');
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(transformed, {
    module,
    exports: module.exports,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    join: path.join,
    console,
  });
  const exported = module.exports as {
    id: string;
    setup: (ctx: unknown) => Promise<void>;
  };
  return exported;
}

/** 假 ctx：捕获 `ctx.session.hook(name, cb)` 注册的回调。 */
function fakeSetupContext(location: string): {
  ctx: unknown;
  hooks: Map<string, (event: unknown) => void>;
} {
  const hooks = new Map<string, (event: unknown) => void>();
  const ctx = {
    location: { directory: location },
    session: {
      hook: async (name: string, cb: (event: unknown) => void) => {
        hooks.set(name, cb);
        return { dispose: async () => undefined };
      },
    },
  };
  return { ctx, hooks };
}

describe('插件模块形态（与既有生成器同口径）', () => {
  it('Plugin.define + 动态 import + identity 兜底 + setup 防呆 + 稳定 id', () => {
    const source = renderSystemHandoffPlugin({ handoffDir: '/tmp/handoff' });
    expect(source).toContain('Plugin.define({');
    expect(source).toContain('await import("@opencode/plugin")');
    expect(source).toContain('Plugin: { define: (plugin: unknown) => plugin }');
    expect(source).toContain('if (!ctx?.session?.hook) return');
    expect(source).toContain(`id: ${JSON.stringify(SYSTEM_HANDOFF_PLUGIN_ID)}`);
    expect(source).toContain('ctx.session.hook("context"');
    expect(source).toContain('event.system.push({ type: "text", text: blob })');
  });

  it('产物形态与既有生成器一致：**不**出现 codemode 选项（那是工具的属性，不是钩子的）', () => {
    const source = renderSystemHandoffPlugin({ handoffDir: '/tmp/handoff' });
    expect(source).not.toContain('codemode');
    expect(source).not.toContain('ctx.tool.transform');
  });

  it('交接目录写死进产物（worker 与 serve 同容器同卷 ⇒ 插件读得到）', () => {
    const source = renderSystemHandoffPlugin({ handoffDir: '/data/vteam-worker/.x' });
    expect(source).toContain('const HANDOFF_DIR = "/data/vteam-worker/.x"');
  });

  it('会话 id 正则与 worker 侧同源（两侧必须一致，故由同一常量生成）', () => {
    const source = renderSystemHandoffPlugin({ handoffDir: '/tmp/handoff' });
    expect(source).toContain(JSON.stringify(HANDOFF_SESSION_ID_RE.source));
  });
});

describe('插件行为（context hook 推进 system 段）', () => {
  it('有交接文件 → blob 被推进 event.system（**逐字节原样**）', async () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      installSystemHandoffPlugin(workDir);
      store.deliver('ses_abc', BLOB);
      const plugin = evaluatePluginModule(
        renderSystemHandoffPlugin({ handoffDir: resolveSystemHandoffDir(workDir) }),
      );
      const { ctx, hooks } = fakeSetupContext(LOCATION);
      await plugin.setup(ctx);
      const callback = hooks.get('context');
      expect(callback).toBeDefined();
      const event: { sessionID: string; system: unknown[] } = {
        sessionID: 'ses_abc',
        system: [],
      };
      await callback!(event);
      expect(event.system).toEqual([{ type: 'text', text: BLOB }]);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('没有交接文件 → **no-op**（不推空段：空 system part 会污染模型请求）', async () => {
    const workDir = tempWorkDir();
    try {
      installSystemHandoffPlugin(workDir);
      const plugin = evaluatePluginModule(
        renderSystemHandoffPlugin({ handoffDir: resolveSystemHandoffDir(workDir) }),
      );
      const { ctx, hooks } = fakeSetupContext(LOCATION);
      await plugin.setup(ctx);
      const event: { sessionID: string; system: unknown[] } = {
        sessionID: 'ses_none',
        system: [],
      };
      await hooks.get('context')!(event);
      expect(event.system).toEqual([]);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('别的会话的交接文件不会被本会话读到（按 sessionID 取文件）', async () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      installSystemHandoffPlugin(workDir);
      store.deliver('ses_a', 'BLOB_A');
      const plugin = evaluatePluginModule(
        renderSystemHandoffPlugin({ handoffDir: resolveSystemHandoffDir(workDir) }),
      );
      const { ctx, hooks } = fakeSetupContext(LOCATION);
      await plugin.setup(ctx);
      const event: { sessionID: string; system: unknown[] } = {
        sessionID: 'ses_b',
        system: [],
      };
      await hooks.get('context')!(event);
      expect(event.system).toEqual([]);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('插件 setup 会写**该 location 的就绪标记**（worker 据此判定"插件已为该 location 加载"）', async () => {
    const workDir = tempWorkDir();
    try {
      installSystemHandoffPlugin(workDir);
      const plugin = evaluatePluginModule(
        renderSystemHandoffPlugin({ handoffDir: resolveSystemHandoffDir(workDir) }),
      );
      const { ctx } = fakeSetupContext(LOCATION);
      await plugin.setup(ctx);
      const store = new SystemHandoffStore(workDir);
      expect(store.locationReady(LOCATION)).toBe(true);
      // ⚠️ **按 location 分桶**：别的 location 加载过 ⇒ 本 location 仍未就绪
      expect(store.locationReady('/data/vteam-worker/teams/tm_other')).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('**两侧的位置哈希算法一致**（插件写的标记 worker 找得到——否则永远退回前缀兜底）', async () => {
    const workDir = tempWorkDir();
    try {
      installSystemHandoffPlugin(workDir);
      const plugin = evaluatePluginModule(
        renderSystemHandoffPlugin({ handoffDir: resolveSystemHandoffDir(workDir) }),
      );
      const store = new SystemHandoffStore(workDir);
      for (const location of ['/a', '/data/vteam-worker', '/data/vteam-worker/teams/tm_1']) {
        const { ctx } = fakeSetupContext(location);
        await plugin.setup(ctx);
        expect(store.locationReady(location)).toBe(true);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('v1 形态的 ctx（没有 ctx.session.hook）→ setup 直接返回，不炸', async () => {
    const workDir = tempWorkDir();
    try {
      const plugin = evaluatePluginModule(
        renderSystemHandoffPlugin({ handoffDir: resolveSystemHandoffDir(workDir) }),
      );
      await expect(plugin.setup({})).resolves.toBeUndefined();
      await expect(plugin.setup(undefined)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('交接通道（写一次、读多次、原子、有界、失败降级）', () => {
  it('deliver 写出的文件内容**恰好**是 blob（逐字节，无增删）', () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      expect(store.deliver('ses_1', BLOB)).toBe(true);
      const file = resolveSystemHandoffFile(workDir, 'ses_1')!;
      expect(fs.readFileSync(file, 'utf8')).toBe(BLOB);
      expect(store.read('ses_1')).toBe(BLOB);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('同内容重复 deliver ⇒ **不重写**（inode 不变 ⇒ 前缀缓存与并发读都不受影响）', () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      store.deliver('ses_1', BLOB);
      const file = resolveSystemHandoffFile(workDir, 'ses_1')!;
      const before = fs.statSync(file).ino;
      store.deliver('ses_1', BLOB);
      store.deliver('ses_1', BLOB);
      expect(fs.statSync(file).ino).toBe(before);
      expect(fs.readFileSync(file, 'utf8')).toBe(BLOB);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('内容真的变了 ⇒ 重写 + 显式告警（provider 前缀缓存会从那一刻起重建）', () => {
    const workDir = tempWorkDir();
    try {
      const warn = jest.fn();
      const store = new SystemHandoffStore(workDir, { logger: { warn } });
      store.deliver('ses_1', BLOB);
      expect(store.deliver('ses_1', 'BLOB-CHANGED')).toBe(true);
      expect(store.read('ses_1')).toBe('BLOB-CHANGED');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('前缀缓存'));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('写盘失败 ⇒ 返回 false（**不抛错**）：调用方据此退回文本前缀兜底', () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      // 用一个"文件占位"的目录 ⇒ mkdirSync 必然失败
      fs.writeFileSync(path.join(workDir, SYSTEM_HANDOFF_DIR_NAME), 'not-a-dir', 'utf8');
      expect(store.deliver('ses_1', BLOB)).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('会话 id 形态非法 ⇒ 拒绝交付（路径穿越防线）', () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      expect(store.deliver('../../etc/passwd', BLOB)).toBe(false);
      expect(store.deliver('ses/../x', BLOB)).toBe(false);
      expect(resolveSystemHandoffFile(workDir, '../evil')).toBeNull();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('clear 幂等：删掉交接文件（走前缀兜底时必须调用 ⇒ 绝不重复注入）', () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      store.deliver('ses_1', BLOB);
      store.clear('ses_1');
      expect(store.read('ses_1')).toBeNull();
      expect(() => store.clear('ses_1')).not.toThrow();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('目录有界：条目数超上限 ⇒ 按 mtime 淘汰最旧的（就绪标记不计入）', () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      for (let i = 0; i < SYSTEM_HANDOFF_MAX_ENTRIES + 5; i++) {
        store.deliver(`ses_${i}`, `BLOB_${i}`);
      }
      const files = fs
        .readdirSync(resolveSystemHandoffDir(workDir))
        .filter((name) => name.endsWith('.txt'));
      expect(files.length).toBeLessThanOrEqual(SYSTEM_HANDOFF_MAX_ENTRIES);
      // 最旧的几个已被淘汰，最新的还在
      expect(store.read(`ses_${SYSTEM_HANDOFF_MAX_ENTRIES + 4}`)).toBe(
        `BLOB_${SYSTEM_HANDOFF_MAX_ENTRIES + 4}`,
      );
      expect(store.read('ses_0')).toBeNull();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('协商：插件文件在位 ⇒ pluginInstalled()=true；不在位 ⇒ false（老镜像走前缀兜底）', () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      expect(store.pluginInstalled()).toBe(false);
      const pluginPath = installSystemHandoffPlugin(workDir);
      expect(pluginPath.endsWith(path.join('.opencode', 'plugins', SYSTEM_HANDOFF_PLUGIN_FILE))).toBe(
        true,
      );
      expect(store.pluginInstalled()).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('协商：该 location 的就绪标记缺失 ⇒ 未就绪；写上 ⇒ 就绪；invalidateReady() ⇒ 又变未就绪', () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      expect(store.locationReady(LOCATION)).toBe(false);
      fs.mkdirSync(store.readyDir, { recursive: true });
      fs.writeFileSync(
        path.join(store.readyDir, `${locationHash(LOCATION)}.txt`),
        LOCATION,
        'utf8',
      );
      expect(store.locationReady(LOCATION)).toBe(true);
      store.invalidateReady();
      expect(store.locationReady(LOCATION)).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('awaitLocationReady：标记在等待窗口内出现 ⇒ true；始终不出现 ⇒ false（**不抛错**）', async () => {
    const workDir = tempWorkDir();
    try {
      const store = new SystemHandoffStore(workDir);
      const pending = store.awaitLocationReady(LOCATION, 1_000);
      setTimeout(() => {
        fs.mkdirSync(store.readyDir, { recursive: true });
        fs.writeFileSync(
          path.join(store.readyDir, `${locationHash(LOCATION)}.txt`),
          LOCATION,
          'utf8',
        );
      }, 120);
      await expect(pending).resolves.toBe(true);

      const missing = new SystemHandoffStore(tempWorkDir());
      await expect(missing.awaitLocationReady(LOCATION, 150)).resolves.toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
