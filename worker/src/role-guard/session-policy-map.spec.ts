/**
 * session-policy-map 测试（Todo 19）：
 * 原子写（temp+rename 无残留）、双会话并发不损坏、缺失/损坏读 null、
 * 删除幂等、路径穿越消毒。
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  pruneStaleSessionPolicies,
  readSessionPolicy,
  removeSessionPolicy,
  sanitizeSessionId,
  sessionPolicyFilePath,
  writeSessionPolicy,
} from './session-policy-map';

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-session-map-'));
}

describe('session-policy-map', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = makeWorkDir();
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('write 后 read 回 `{agent, dir}`（sessions/ 自动创建）', async () => {
    await writeSessionPolicy(workDir, 'ses_abc', {
      agent: 'vteam-developer',
      dir: '/data/vteam-worker/tasks/t_1',
    });
    expect(fs.existsSync(path.join(workDir, '.vteam-role-guard', 'sessions'))).toBe(true);
    await expect(readSessionPolicy(workDir, 'ses_abc')).resolves.toEqual({
      agent: 'vteam-developer',
      dir: '/data/vteam-worker/tasks/t_1',
    });
  });

  it('原子写：落盘后同目录无 .tmp 残留，且内容为完整 JSON', async () => {
    await writeSessionPolicy(workDir, 'ses_1', { agent: 'vteam-plan', dir: '/w/tasks/t_1' });
    const dir = path.join(workDir, '.vteam-role-guard', 'sessions');
    expect(fs.readdirSync(dir)).toEqual(['ses_1.json']);
    const raw = fs.readFileSync(path.join(dir, 'ses_1.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('双会话并发写互不损坏（各读回各自映射）', async () => {
    await Promise.all([
      writeSessionPolicy(workDir, 'ses_a', { agent: 'vteam-developer', dir: '/w/tasks/t_a' }),
      writeSessionPolicy(workDir, 'ses_b', { agent: 'vteam-tester', dir: '/w/tasks/t_b' }),
    ]);
    await expect(readSessionPolicy(workDir, 'ses_a')).resolves.toEqual({
      agent: 'vteam-developer',
      dir: '/w/tasks/t_a',
    });
    await expect(readSessionPolicy(workDir, 'ses_b')).resolves.toEqual({
      agent: 'vteam-tester',
      dir: '/w/tasks/t_b',
    });
  });

  it('同一会话并发写收敛为合法 JSON（后写者胜其一，不损坏）', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writeSessionPolicy(workDir, 'ses_race', {
          agent: `vteam-developer`,
          dir: `/w/tasks/t_${i}`,
        }),
      ),
    );
    const got = await readSessionPolicy(workDir, 'ses_race');
    expect(got).not.toBeNull();
    expect(got?.agent).toBe('vteam-developer');
    const dir = path.join(workDir, '.vteam-role-guard', 'sessions');
    expect(fs.readdirSync(dir)).toEqual(['ses_race.json']);
  });

  it('read 缺失返回 null；损坏/形状非法返回 null', async () => {
    await expect(readSessionPolicy(workDir, 'ses_missing')).resolves.toBeNull();
    const target = sessionPolicyFilePath(workDir, 'ses_bad');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, 'not-json{{{', 'utf8');
    await expect(readSessionPolicy(workDir, 'ses_bad')).resolves.toBeNull();
    await fsp.writeFile(target, JSON.stringify({ agent: 'vteam-developer' }), 'utf8');
    await expect(readSessionPolicy(workDir, 'ses_bad')).resolves.toBeNull();
    await fsp.writeFile(target, JSON.stringify(['array']), 'utf8');
    await expect(readSessionPolicy(workDir, 'ses_bad')).resolves.toBeNull();
  });

  it('remove 幂等：写后删可读 null；重复删/删缺失不抛', async () => {
    await writeSessionPolicy(workDir, 'ses_del', { agent: 'vteam-tester', dir: '/w' });
    await removeSessionPolicy(workDir, 'ses_del');
    await expect(readSessionPolicy(workDir, 'ses_del')).resolves.toBeNull();
    await expect(removeSessionPolicy(workDir, 'ses_del')).resolves.toBeUndefined();
    await expect(removeSessionPolicy(workDir, 'ses_never')).resolves.toBeUndefined();
  });

  it('路径穿越消毒：`../../etc/passwd` 不逃出 sessions/，且同 id 可读写', async () => {
    const evil = '../../etc/passwd';
    expect(sanitizeSessionId(evil)).not.toContain('/');
    const filePath = sessionPolicyFilePath(workDir, evil);
    const sessionsDir = path.join(workDir, '.vteam-role-guard', 'sessions');
    expect(path.dirname(filePath)).toBe(sessionsDir);
    await writeSessionPolicy(workDir, evil, { agent: 'vteam-developer', dir: '/w' });
    await expect(readSessionPolicy(workDir, evil)).resolves.toEqual({
      agent: 'vteam-developer',
      dir: '/w',
    });
    // 工作区根外无逃逸文件
    expect(fs.existsSync(path.join(workDir, 'etc'))).toBe(false);
    await removeSessionPolicy(workDir, evil);
    await expect(readSessionPolicy(workDir, evil)).resolves.toBeNull();
  });

  it('sanitize：空串/`..` 回落占位名', () => {
    expect(sanitizeSessionId('')).toBe('unknown-session');
    expect(sanitizeSessionId('..')).toBe('unknown-session');
    expect(sanitizeSessionId('ses_1')).toBe('ses_1');
  });

  it('同一会话 id 顺序重写 → 最新 agent 权威（复用会话换角色不误标）', async () => {
    await writeSessionPolicy(workDir, 'ses_reuse', {
      agent: 'vteam-product',
      dir: '/w/tasks/t_1',
    });
    await writeSessionPolicy(workDir, 'ses_reuse', {
      agent: 'vteam-architect',
      dir: '/w/tasks/t_2',
    });
    await expect(readSessionPolicy(workDir, 'ses_reuse')).resolves.toEqual({
      agent: 'vteam-architect',
      dir: '/w/tasks/t_2',
    });
  });

  it('TTL 清理：过期 json 删除，新鲜 json/非 json/缺失目录不动', async () => {
    const sessionsDir = path.join(workDir, '.vteam-role-guard', 'sessions');
    await fsp.mkdir(sessionsDir, { recursive: true });
    const oldFile = path.join(sessionsDir, 'ses_old.json');
    const freshFile = path.join(sessionsDir, 'ses_fresh.json');
    const otherFile = path.join(sessionsDir, 'keep.txt');
    await fsp.writeFile(oldFile, JSON.stringify({ agent: 'vteam-product', dir: '/w' }), 'utf8');
    await fsp.writeFile(freshFile, JSON.stringify({ agent: 'vteam-architect', dir: '/w' }), 'utf8');
    await fsp.writeFile(otherFile, 'not-a-mapping', 'utf8');
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fsp.utimes(oldFile, aged, aged);
    await expect(pruneStaleSessionPolicies(workDir)).resolves.toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
    expect(fs.existsSync(otherFile)).toBe(true);
    // 缺失 sessions/ → 0，不抛
    await expect(pruneStaleSessionPolicies(path.join(workDir, 'no-such-root'))).resolves.toBe(
      0,
    );
  });
});
