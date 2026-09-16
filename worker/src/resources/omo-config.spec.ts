import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  OMO_AGENT_NAMES,
  readOmoAgents,
  SEEDED_OMO_AGENT_MODELS,
  SEEDED_OMO_DEFAULT_MODEL,
  seedOmoAgentModels,
} from './omo-config';

function tmpWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omo-seed-'));
}

describe('seedOmoAgentModels（新卷种子默认）', () => {
  it('无任何配置文件 → 写入内置默认并返回映射', () => {
    const dir = tmpWorkDir();
    const seeded = seedOmoAgentModels(dir);
    expect(seeded).toEqual({ ...SEEDED_OMO_AGENT_MODELS });
    expect(Object.keys(SEEDED_OMO_AGENT_MODELS).sort()).toEqual(
      [...OMO_AGENT_NAMES].sort(),
    );
    expect(SEEDED_OMO_DEFAULT_MODEL).toBe('opencode/big-pickle');
    expect(readOmoAgents(dir)).toMatchObject({ ...SEEDED_OMO_AGENT_MODELS });
  });

  it('已有新位置文件 → 跳过不覆盖（用户修改优先）', () => {
    const dir = tmpWorkDir();
    fs.mkdirSync(path.join(dir, '.omo'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.omo', 'omo.jsonc'),
      JSON.stringify({ agents: { explore: { model: 'custom/x' } } }),
    );
    expect(seedOmoAgentModels(dir)).toBe(null);
    expect(readOmoAgents(dir).explore).toBe('custom/x');
  });
});
