import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cleanup,
  createTempKey,
  resolveGitEnv,
  TEMP_KEY_MODE,
  TEMP_KEY_PREFIX,
} from './git-credentials';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-git-cred-spec-'));

describe('resolveGitEnv（GIT_SSH_COMMAND 构造，17 篇 §6.1）', () => {
  it('credential.keyPath 存在时构造 GIT_SSH_COMMAND：ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=no', () => {
    const env = resolveGitEnv({ keyPath: '/tmp/keta-cred-abc' }, {});
    expect(env).toEqual({
      GIT_SSH_COMMAND: 'ssh -i /tmp/keta-cred-abc -o IdentitiesOnly=yes -o StrictHostKeyChecking=no',
    });
  });

  it('credential 未提供 keyPath 时回退 config.gitSshKeyPath（GIT_SSH_KEY_PATH）', () => {
    const env = resolveGitEnv(undefined, { gitSshKeyPath: '/home/k/.ssh/id_ed25519' });
    expect(env.GIT_SSH_COMMAND).toContain('-i /home/k/.ssh/id_ed25519');
  });

  it('credential.keyPath 优先于 config.gitSshKeyPath', () => {
    const env = resolveGitEnv({ keyPath: '/tmp/temp-key' }, { gitSshKeyPath: '/home/k/.ssh/old' });
    expect(env.GIT_SSH_COMMAND).toContain('-i /tmp/temp-key');
    expect(env.GIT_SSH_COMMAND).not.toContain('/home/k/.ssh/old');
  });

  it('keyPath 为空串或空白时视为缺省，回退 config', () => {
    const env = resolveGitEnv({ keyPath: '   ' }, { gitSshKeyPath: '/cfg/key' });
    expect(env.GIT_SSH_COMMAND).toContain('-i /cfg/key');
  });

  it('credential 与 config 均无 keyPath 时返回空 env（不注入）', () => {
    expect(resolveGitEnv(undefined, {})).toEqual({});
    expect(resolveGitEnv({ keyPath: '' }, { gitSshKeyPath: ' ' })).toEqual({});
  });

  it('options 可覆盖 IdentitiesOnly 与 StrictHostKeyChecking', () => {
    const env = resolveGitEnv({ keyPath: '/tmp/k' }, {}, { identitiesOnly: false, strictHostKeyChecking: 'ask' });
    expect(env.GIT_SSH_COMMAND).toContain('-o IdentitiesOnly=no -o StrictHostKeyChecking=ask');
  });
});

describe('createTempKey / cleanup（临时 key 生命周期，17 篇 §5.4）', () => {
  it('写入 os.tmpdir()/keta-cred-<random>，内容一致，权限 600', () => {
    const contents = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\n';
    const keyPath = createTempKey(contents);
    try {
      expect(path.dirname(keyPath)).toBe(os.tmpdir());
      expect(path.basename(keyPath)).toMatch(new RegExp(`^${TEMP_KEY_PREFIX}[0-9a-f]{32}$`));
      expect(fs.readFileSync(keyPath, 'utf8')).toBe(contents);
      expect(fs.statSync(keyPath).mode & 0o777).toBe(TEMP_KEY_MODE);
    } finally {
      cleanup(keyPath);
    }
  });

  it('两次创建路径随机不同', () => {
    const a = createTempKey('k1');
    const b = createTempKey('k2');
    try {
      expect(a).not.toBe(b);
    } finally {
      cleanup(a);
      cleanup(b);
    }
  });

  it('options 可指定 dir / prefix / mode', () => {
    const keyPath = createTempKey('custom', { dir: TMP_DIR, prefix: 'my-key-', mode: 0o640 });
    try {
      expect(path.dirname(keyPath)).toBe(TMP_DIR);
      expect(path.basename(keyPath)).toMatch(/^my-key-[0-9a-f]{32}$/);
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o640);
    } finally {
      cleanup(keyPath);
    }
  });

  it('cleanup 删除文件；对不存在文件幂等不抛错', () => {
    const keyPath = createTempKey('gone');
    expect(fs.existsSync(keyPath)).toBe(true);
    cleanup(keyPath);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(() => cleanup(keyPath)).not.toThrow();
  });
});
