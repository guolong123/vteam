/**
 * 敏感命令模块测试（sensitive-command-tool todo 3）。
 *
 * 对抗类覆盖：畸形输入（重叠 secret、正则元字符、多行、超短值、未绑定占位符）、
 * 挂起/长命令（远端进程组被杀）、stale_state（连续调用的截断 flag 不串扰）、
 * misleading_success_output（按实际字节数断言，不看摘要）、secrets（sentinel 扫描）。
 * prompt injection 对本模块不适用（输入是命令模板而非自然语言指令）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_SENSITIVE_OUTPUT_BYTES,
  SensitiveCommandError,
  SensitiveCommandInput,
  runSensitiveCommand,
  scrubSecrets,
  substituteTemplate,
} from './sensitive-command';

jest.setTimeout(30000);

const SENTINEL = 's3cr3t-A9f';

let workDir: string;

beforeEach(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sens-cmd-')));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 断言进程组已消失（SIGKILL 后短暂重试，防调度延迟误报）。 */
async function expectGroupGone(pgid: number): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
      return;
    }
    await sleep(50);
  }
  throw new Error(`process group ${pgid} still alive after 3s`);
}

async function captureError(
  input: SensitiveCommandInput,
  opts: { workDir: string },
): Promise<SensitiveCommandError> {
  try {
    await runSensitiveCommand(input, opts);
  } catch (err) {
    return err as SensitiveCommandError;
  }
  throw new Error('expected SensitiveCommandError was not thrown');
}

describe('substituteTemplate', () => {
  it('替换已声明占位符，未声明占位符原样保留（多行、重复占位符）', () => {
    const template = 'mysql -p{{PASSWORD}} -e "select 1"\necho {{PASSWORD}} {{UNBOUND}}';
    const out = substituteTemplate(template, { PASSWORD: SENTINEL });
    expect(out).toBe(
      `mysql -p${SENTINEL} -e "select 1"\necho ${SENTINEL} {{UNBOUND}}`,
    );
  });

  it('占位符不匹配字符集时原样保留', () => {
    expect(substituteTemplate('echo {{bad-name}} {{A.B}}', { 'bad-name': 'x', 'A.B': 'y' })).toBe(
      'echo {{bad-name}} {{A.B}}',
    );
  });

  it('插入值不再被二次扫描（secret 值里含占位符不级联替换）', () => {
    expect(substituteTemplate('echo {{A}}', { A: '{{B}}', B: 'nope' })).toBe('echo {{B}}');
  });

  it('畸形模板：空串、NUL、非字符串一律拒绝', () => {
    expect(() => substituteTemplate('', {})).toThrow(SensitiveCommandError);
    expect(() => substituteTemplate('echo \0x', {})).toThrow(SensitiveCommandError);
    expect(() => substituteTemplate(123 as unknown as string, {})).toThrow(SensitiveCommandError);
    try {
      substituteTemplate('echo \0x', {});
      throw new Error('should throw');
    } catch (err) {
      expect((err as SensitiveCommandError).code).toBe('invalid_template');
      expect((err as SensitiveCommandError).message).not.toContain('\0');
    }
  });

  it('畸形 secrets：数组、非字符串值一律拒绝', () => {
    expect(() => substituteTemplate('echo {{A}}', [] as unknown as Record<string, string>)).toThrow(
      SensitiveCommandError,
    );
    expect(() =>
      substituteTemplate('echo {{A}}', { A: 1 as unknown as string }),
    ).toThrow(SensitiveCommandError);
  });
});

describe('scrubSecrets', () => {
  it('正则元字符 secret 走纯字符串替换，不因转义差异漏替换', () => {
    const secret = 'p@ss.w+rd[1]$^(a|b)*';
    const text = `auth ${secret} failed; retry ${secret}`;
    const out = scrubSecrets(text, { PWD: secret });
    expect(out).toBe('auth {{REDACTED}} failed; retry {{REDACTED}}');
    expect(out).not.toContain(secret);
  });

  it('重叠 secret 按长度降序替换，长串区域不被短串切碎后残留', () => {
    const out = scrubSecrets('x abcdef y cde z abcdef', { LONG: 'abcdef', SHORT: 'cde' });
    expect(out).toBe('x {{REDACTED}} y {{REDACTED}} z {{REDACTED}}');
    expect(out).not.toContain('abcdef');
    expect(out).not.toContain('cde');
  });

  it('超短 secret（单字符）全部命中', () => {
    const out = scrubSecrets('banana', { S: 'a' });
    expect(out).toBe('b{{REDACTED}}n{{REDACTED}}n{{REDACTED}}');
  });

  it('多行输出逐行精确替换', () => {
    const text = `line1 ${SENTINEL}\nline2\nline3 ${SENTINEL} tail`;
    const out = scrubSecrets(text, { T: SENTINEL });
    expect(out).toBe('line1 {{REDACTED}}\nline2\nline3 {{REDACTED}} tail');
    expect(out).not.toContain(SENTINEL);
  });

  it('残留 {{UNBOUND}} 占位符被掩码', () => {
    expect(scrubSecrets('token={{UNBOUND}} ok={{A}}', {})).toBe(
      'token={{REDACTED}} ok={{REDACTED}}',
    );
  });

  it('空 secret 值被忽略（不产生逐字符撕裂）', () => {
    expect(scrubSecrets('abc', { EMPTY: '' })).toBe('abc');
  });

  it('空文本原样返回', () => {
    expect(scrubSecrets('', { A: 'x' })).toBe('');
  });
});

describe('runSensitiveCommand 输出脱敏与截断', () => {
  it('happy path：exit 0、stdout 完整、双流 flag 为 false、不含渲染命令', async () => {
    const output = await runSensitiveCommand(
      { commandTemplate: 'printf hello', secrets: {} },
      { workDir },
    );
    expect(output.status).toBe('succeeded');
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toBe('hello');
    expect(output.stderr).toBe('');
    expect(output.stdoutTruncated).toBe(false);
    expect(output.stderrTruncated).toBe(false);
    expect(output.error).toBeUndefined();
    expect(typeof output.durationMs).toBe('number');
    expect(JSON.stringify(output)).not.toContain('printf');
  });

  it('sentinel 出现在 stdout/stderr/失败路径时，全结果 0 命中', async () => {
    const template = `printf 'out ${SENTINEL}\\n'; printf 'err ${SENTINEL}\\n' >&2; exit 7`;
    const output = await runSensitiveCommand(
      { commandTemplate: template, secrets: { TOKEN: SENTINEL } },
      { workDir },
    );
    expect(output.status).toBe('failed');
    expect(output.exitCode).toBe(7);
    expect(output.stdout).toBe('out {{REDACTED}}\n');
    expect(output.stderr).toBe('err {{REDACTED}}\n');
    expect(output.error).toBeUndefined();
    const wire = JSON.stringify(output);
    expect(wire).not.toContain(SENTINEL);
    expect(wire).not.toContain('printf');
    expect(wire).not.toContain(template);
  });

  it('模板渲染后的 secret 值在执行输出中被精确替换', async () => {
    const output = await runSensitiveCommand(
      { commandTemplate: `printf '%s' '{{TOKEN}}'`, secrets: { TOKEN: SENTINEL } },
      { workDir },
    );
    expect(output.status).toBe('succeeded');
    expect(output.stdout).toBe('{{REDACTED}}');
    expect(JSON.stringify(output)).not.toContain(SENTINEL);
  });

  it('未绑定占位符经命令输出后被掩码', async () => {
    const output = await runSensitiveCommand(
      { commandTemplate: `printf '%s' '{{UNBOUND}}'`, secrets: {} },
      { workDir },
    );
    expect(output.stdout).toBe('{{REDACTED}}');
  });

  it('40KB+ 双流各截断到 32768 字节（按实际字节数断言）', async () => {
    const node = process.execPath;
    const template = `'${node}' -e "process.stdout.write('x'.repeat(45000)); process.stderr.write('y'.repeat(45000))"`;
    const output = await runSensitiveCommand(
      { commandTemplate: template, secrets: {} },
      { workDir },
    );
    expect(output.status).toBe('succeeded');
    expect(Buffer.byteLength(output.stdout, 'utf8')).toBe(MAX_SENSITIVE_OUTPUT_BYTES);
    expect(Buffer.byteLength(output.stderr, 'utf8')).toBe(MAX_SENSITIVE_OUTPUT_BYTES);
    expect(output.stdoutTruncated).toBe(true);
    expect(output.stderrTruncated).toBe(true);
    expect(output.stdout).toBe('x'.repeat(MAX_SENSITIVE_OUTPUT_BYTES));
    expect(output.stderr).toBe('y'.repeat(MAX_SENSITIVE_OUTPUT_BYTES));
  });

  it('多字节字符输出截断后仍不超过 32768 字节', async () => {
    const node = process.execPath;
    const template = `'${node}' -e "process.stdout.write('中'.repeat(20000))"`;
    const output = await runSensitiveCommand(
      { commandTemplate: template, secrets: {} },
      { workDir },
    );
    expect(output.status).toBe('succeeded');
    expect(Buffer.byteLength(output.stdout, 'utf8')).toBeLessThanOrEqual(MAX_SENSITIVE_OUTPUT_BYTES);
    expect(output.stdoutTruncated).toBe(true);
    expect(output.stdout.length).toBeGreaterThan(9000);
  });

  it('stale_state：大输出之后的调用截断 flag 归零，且并发调用结果互不串扰', async () => {
    const node = process.execPath;
    const big = await runSensitiveCommand(
      { commandTemplate: `'${node}' -e "process.stdout.write('x'.repeat(45000))"`, secrets: {} },
      { workDir },
    );
    expect(big.stdoutTruncated).toBe(true);

    const [a, b] = await Promise.all([
      runSensitiveCommand(
        { commandTemplate: `printf alpha`, secrets: { T: SENTINEL } },
        { workDir },
      ),
      runSensitiveCommand(
        { commandTemplate: `printf 'beta ${SENTINEL}'`, secrets: { T: SENTINEL } },
        { workDir },
      ),
    ]);

    expect(a.stdout).toBe('alpha');
    expect(a.stdoutTruncated).toBe(false);
    expect(a.stderrTruncated).toBe(false);
    expect(b.stdout).toBe('beta {{REDACTED}}');
    expect(b.stdoutTruncated).toBe(false);
    expect(JSON.stringify(a)).not.toContain(SENTINEL);
    expect(JSON.stringify(b)).not.toContain(SENTINEL);
  });

  it('长命令正常跑完（长于短超时的反例：超时设大时不得误杀）', async () => {
    const output = await runSensitiveCommand(
      { commandTemplate: 'sleep 1; printf done', secrets: {}, timeoutMs: 10000 },
      { workDir },
    );
    expect(output.status).toBe('succeeded');
    expect(output.stdout).toBe('done');
    expect(output.durationMs).toBeGreaterThanOrEqual(900);
  });
});

describe('runSensitiveCommand cwd 约束', () => {
  it('拒绝 ../../etc、绝对路径、NUL 与越界段（错误 message 不回显路径）', async () => {
    const cases: Array<{ cwd: string; forbidden: string }> = [
      { cwd: '../../etc', forbidden: 'etc' },
      { cwd: 'repo/../../..', forbidden: '..' },
      { cwd: '/etc', forbidden: '/etc' },
      { cwd: 'a\0b', forbidden: '\0' },
    ];
    for (const item of cases) {
      const err = await captureError(
        { commandTemplate: 'printf x', secrets: { T: SENTINEL }, cwd: item.cwd },
        { workDir },
      );
      expect(err).toBeInstanceOf(SensitiveCommandError);
      expect(err.code).toBe('invalid_cwd');
      expect(err.message).not.toContain(item.forbidden);
      expect(err.message).not.toContain(SENTINEL);
      expect(err.message).not.toContain('printf');
    }
  });

  it('拒绝符号链接逃逸（cwd 解析到 workDir 之外）', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sens-out-')));
    try {
      fs.symlinkSync(outside, path.join(workDir, 'escape'), 'dir');
      const err = await captureError(
        { commandTemplate: 'printf x', secrets: {}, cwd: 'escape' },
        { workDir },
      );
      expect(err.code).toBe('invalid_cwd');
      expect(err.message).not.toContain(outside);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('拒绝不存在的 cwd 与文件型 cwd', async () => {
    const missing = await captureError(
      { commandTemplate: 'printf x', secrets: {}, cwd: 'nope' },
      { workDir },
    );
    expect(missing.code).toBe('invalid_cwd');

    const filePath = path.join(workDir, 'a.txt');
    fs.writeFileSync(filePath, 'x');
    const notDir = await captureError(
      { commandTemplate: 'printf x', secrets: {}, cwd: 'a.txt' },
      { workDir },
    );
    expect(notDir.code).toBe('invalid_cwd');
    expect(notDir.message).not.toContain('a.txt');
  });

  it('合法相对子目录可用，实际 pwd 为 realpath', async () => {
    fs.mkdirSync(path.join(workDir, 'repo'));
    const output = await runSensitiveCommand(
      { commandTemplate: 'pwd', secrets: {}, cwd: 'repo' },
      { workDir },
    );
    expect(output.status).toBe('succeeded');
    expect(output.stdout.trim()).toBe(fs.realpathSync(path.join(workDir, 'repo')));
  });

  it('缺省 cwd = workDir 根', async () => {
    const output = await runSensitiveCommand(
      { commandTemplate: 'pwd', secrets: {} },
      { workDir },
    );
    expect(output.stdout.trim()).toBe(workDir);
  });

  it('workDir 未配置 / 不可解析时拒绝', async () => {
    const err = await captureError(
      { commandTemplate: 'printf x', secrets: {} },
      { workDir: '' },
    );
    expect(err.code).toBe('invalid_workdir');
    const err2 = await captureError(
      { commandTemplate: 'printf x', secrets: {} },
      { workDir: path.join(workDir, 'missing') },
    );
    expect(err2.code).toBe('invalid_workdir');
  });
});

describe('runSensitiveCommand 超时与进程组', () => {
  it('异步超时后进程组（含孙进程）被杀', async () => {
    const pgidFile = path.join(workDir, 'pgid.txt');
    const output = await runSensitiveCommand(
      {
        commandTemplate: `printf '%s' "$$" > pgid.txt; sleep 60`,
        secrets: { T: SENTINEL },
        timeoutMs: 600,
      },
      { workDir },
    );
    expect(output.status).toBe('timeout');
    expect(output.exitCode).toBeNull();
    expect(output.durationMs).toBeLessThan(10000);
    expect(JSON.stringify(output)).not.toContain(SENTINEL);

    const pgid = Number(fs.readFileSync(pgidFile, 'utf8').trim());
    expect(Number.isInteger(pgid)).toBe(true);
    expect(pgid).toBeGreaterThan(0);
    await expectGroupGone(pgid);
  }, 30000);

  it('AbortSignal 取消与超时同路径（进程组被杀，结果为 timeout）', async () => {
    const pgidFile = path.join(workDir, 'pgid.txt');
    const controller = new AbortController();
    const pending = runSensitiveCommand(
      {
        commandTemplate: `printf '%s' "$$" > pgid.txt; sleep 60`,
        secrets: {},
        timeoutMs: 20000,
      },
      { workDir, signal: controller.signal },
    );
    await sleep(300);
    controller.abort();
    const output = await pending;
    expect(output.status).toBe('timeout');

    const pgid = Number(fs.readFileSync(pgidFile, 'utf8').trim());
    await expectGroupGone(pgid);
  }, 30000);

  it('信号在启动前已触发时不 spawn，直接返回 timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const output = await runSensitiveCommand(
      { commandTemplate: 'printf started', secrets: {} },
      { workDir, signal: controller.signal },
    );
    expect(output.status).toBe('timeout');
    expect(output.stdout).toBe('');
    expect(fs.existsSync(path.join(workDir, 'pgid.txt'))).toBe(false);
  });

  it('畸形输入：非法 timeoutMs 拒绝', async () => {
    for (const bad of [0, -5, Number.NaN, Infinity, 'abc' as unknown as number]) {
      const err = await captureError(
        { commandTemplate: 'printf x', secrets: {}, timeoutMs: bad },
        { workDir },
      );
      expect(err.code).toBe('invalid_timeout');
    }
  });

  it('畸形输入：body 非对象与 secrets 非对象拒绝', async () => {
    const notObject = await captureError(
      null as unknown as SensitiveCommandInput,
      { workDir },
    );
    expect(notObject.code).toBe('invalid_input');

    const arraySecrets = await captureError(
      { commandTemplate: 'printf x', secrets: [] as unknown as Record<string, string> },
      { workDir },
    );
    expect(arraySecrets.code).toBe('invalid_secrets');
  });

  it('cwd 不可执行（无权限）时 spawn 失败：status failed、error 固定文案、无路径泄露', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const locked = path.join(workDir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const output = await runSensitiveCommand(
        { commandTemplate: `printf '${SENTINEL}'`, secrets: { T: SENTINEL }, cwd: 'locked' },
        { workDir },
      );
      expect(output.status).toBe('failed');
      expect(output.exitCode).toBeNull();
      expect(output.error).toMatch(/^failed to start the command process/);
      const wire = JSON.stringify(output);
      expect(wire).not.toContain(SENTINEL);
      expect(wire).not.toContain('locked');
      expect(wire).not.toContain('printf');
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});
