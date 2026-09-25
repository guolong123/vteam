import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  OMO_AGENT_NAMES,
  omoConfigUserPath,
  readOmoAgents,
  SEEDED_OMO_AGENT_MODELS,
  SEEDED_OMO_DEFAULT_MODEL,
  seedOmoAgentModels,
} from './omo-config';

/**
 * 落点已从「工作目录」改为「用户级 ~/.omo/omo.jsonc」（不得写作业区）。用例把 HOME 指向
 * 临时目录隔离——`omoConfigUserPath()` 惰性读 `$HOME`，否则会污染真实家目录。
 */
describe('omo-config 落点（用户级 ~/.omo/omo.jsonc）', () => {
  let omoDir: string;
  let prevOmoDir: string | undefined;

  beforeEach(() => {
    omoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-dir-'));
    prevOmoDir = process.env.OMO_CONFIG_DIR;
    process.env.OMO_CONFIG_DIR = omoDir;
  });

  afterEach(() => {
    if (prevOmoDir === undefined) delete process.env.OMO_CONFIG_DIR;
    else process.env.OMO_CONFIG_DIR = prevOmoDir;
  });

  function tmpWorkDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omo-seed-'));
  }

  it('无任何配置文件 → 写入用户级并返回映射（工作目录不留文件）', () => {
    const dir = tmpWorkDir();

    const seeded = seedOmoAgentModels(dir);

    expect(seeded).toEqual({ ...SEEDED_OMO_AGENT_MODELS });
    expect(Object.keys(SEEDED_OMO_AGENT_MODELS).sort()).toEqual(
      [...OMO_AGENT_NAMES].sort(),
    );
    expect(SEEDED_OMO_DEFAULT_MODEL).toBe('opencode/big-pickle');
    expect(readOmoAgents(dir)).toMatchObject({ ...SEEDED_OMO_AGENT_MODELS });
    expect(fs.existsSync(omoConfigUserPath())).toBe(true);
    expect(fs.existsSync(path.join(dir, '.omo', 'omo.jsonc'))).toBe(false);
  });

  it('历史落点（工作目录 .omo/omo.jsonc）→ 迁移到用户级并删旧；不覆盖用户内容', () => {
    const dir = tmpWorkDir();
    fs.mkdirSync(path.join(dir, '.omo'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.omo', 'omo.jsonc'),
      JSON.stringify({ agents: { explore: { model: 'custom/x' } } }),
    );

    expect(seedOmoAgentModels(dir)).toBe(null);
    expect(readOmoAgents(dir).explore).toBe('custom/x');

    expect(fs.existsSync(path.join(dir, '.omo', 'omo.jsonc'))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(omoConfigUserPath(), 'utf8')).agents.explore.model,
    ).toBe('custom/x');
  });

  it('用户级已存在 → 不再种子（用户修改优先），工作目录历史文件不干扰', () => {
    const dir = tmpWorkDir();
    fs.mkdirSync(path.dirname(omoConfigUserPath()), { recursive: true });
    fs.writeFileSync(
      omoConfigUserPath(),
      JSON.stringify({ agents: { explore: { model: 'user/x' } } }),
    );
    fs.mkdirSync(path.join(dir, '.omo'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.omo', 'omo.jsonc'),
      JSON.stringify({ agents: { explore: { model: 'stale/x' } } }),
    );

    expect(seedOmoAgentModels(dir)).toBe(null);
    expect(readOmoAgents(dir).explore).toBe('user/x');
  });
});
