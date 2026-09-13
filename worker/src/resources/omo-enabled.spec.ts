import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isOmoBundled, readOmoEnabled, writeOmoEnabled } from './omo-enabled';

describe('OmO 启用开关', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-enabled-'));
  });
  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it('默认启用：文件不存在时返回 true（保持既有行为，坏文件不会悄悄关掉功能）', () => {
    expect(readOmoEnabled(workDir)).toBe(true);
  });

  it('写入 false 后读取为 false；写回 true 恢复', () => {
    writeOmoEnabled(workDir, false);
    expect(readOmoEnabled(workDir)).toBe(false);
    writeOmoEnabled(workDir, true);
    expect(readOmoEnabled(workDir)).toBe(true);
  });

  it('落点独立于 OmO 自己的配置文件（不会被其迁移/重写波及）', () => {
    const written = writeOmoEnabled(workDir, false);
    expect(written).toBe(path.join(workDir, '.omo', 'omo-enabled.json'));
    expect(fs.existsSync(path.join(workDir, '.omo', 'omo.jsonc'))).toBe(false);
  });

  it('损坏 JSON → 回落 true（不因坏文件关闭功能）', () => {
    writeOmoEnabled(workDir, false);
    fs.writeFileSync(path.join(workDir, '.omo', 'omo-enabled.json'), '{ broken');
    expect(readOmoEnabled(workDir)).toBe(true);
  });

  it('enabled 非 false 的其他值一律视为启用（容错）', () => {
    writeOmoEnabled(workDir, true);
    const p = path.join(workDir, '.omo', 'omo-enabled.json');
    fs.writeFileSync(p, JSON.stringify({ enabled: 'yes' }));
    expect(readOmoEnabled(workDir)).toBe(true);
    fs.writeFileSync(p, JSON.stringify({}));
    expect(readOmoEnabled(workDir)).toBe(true);
  });

  it('isOmoBundled：本机（非镜像）无标记文件 → false', () => {
    // 单测环境不是 worker 镜像，/opt/omo-bundled.json 不存在
    expect(isOmoBundled()).toBe(false);
  });
});
