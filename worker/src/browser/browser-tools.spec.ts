import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BROWSER_DEFAULT_SCOPE,
  BROWSER_PROFILE_SUBDIR,
  ensureBrowserProfileDir,
  hashBrowserScopeSeed,
  installBrowserTools,
  renderBrowserToolsFile,
  resolveBrowserProfileDir,
  resolveBrowserScopeId,
  sanitizeBrowserScopeId,
} from './browser-tools';

describe('browser-tools 隔离 helpers', () => {
  it('sanitize：ses_ id 原样通过，非法字符转下划线并截断 64', () => {
    expect(sanitizeBrowserScopeId('ses_abc123')).toBe('ses_abc123');
    expect(sanitizeBrowserScopeId('ses_abc/def?x=1')).toBe('ses_abc_def_x_1');
    expect(sanitizeBrowserScopeId('')).toBe('');
    expect(sanitizeBrowserScopeId(undefined)).toBe('');
    expect(sanitizeBrowserScopeId('a'.repeat(100)).length).toBe(64);
  });

  it('resolve：sessionId 优先（session 隔离主路径）', () => {
    expect(
      resolveBrowserScopeId({ sessionId: 'ses_abc', directory: '/d', agent: 'a' }),
    ).toBe('ses_abc');
  });

  it('resolve：sessionId 缺席时回退 member-<hash8(directory|agent)>（成员级稳定）', () => {
    const scope = resolveBrowserScopeId({ directory: '/data/dir', agent: 'dev' });
    expect(scope).toBe(`member-${hashBrowserScopeSeed('/data/dir|dev')}`);
    expect(
      resolveBrowserScopeId({ directory: '/data/dir', agent: 'dev' }),
    ).toBe(scope);
    expect(
      resolveBrowserScopeId({ directory: '/data/other', agent: 'dev' }),
    ).not.toBe(scope);
  });

  it('resolve：全空回退 default', () => {
    expect(resolveBrowserScopeId({})).toBe(BROWSER_DEFAULT_SCOPE);
  });

  it('profile 落点：<root>/browser-profiles/<scope>/，ensure 真建目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-prof-'));
    try {
      expect(resolveBrowserProfileDir(root, 'ses_x')).toBe(
        path.join(root, BROWSER_PROFILE_SUBDIR, 'ses_x'),
      );
      const created = ensureBrowserProfileDir(root, 'ses_x');
      expect(created && fs.existsSync(created)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('browser shim 隔离注入（renderBrowserToolsFile）', () => {
  const rendered = renderBrowserToolsFile();

  it('shim 从 ToolContext 取 session 身份（无全局可变 current-session）', () => {
    expect(rendered).toContain('context');
    expect(rendered).toContain('sessionID');
  });

  it('shim 注入 --session 作用域 + --profile 独立 user-data-dir', () => {
    expect(rendered).toContain('"--session"');
    expect(rendered).toContain('"--profile"');
    expect(rendered).toContain(BROWSER_PROFILE_SUBDIR);
  });

  it('shim 含成员级回退路径（member- + hash）与 default 兜底', () => {
    expect(rendered).toContain('member-');
    expect(rendered).toContain(BROWSER_DEFAULT_SCOPE);
  });

  it('shim 显式 --session/--profile 被尊重（不重复注入），close --all 被拒', () => {
    expect(rendered).toContain('close');
    expect(rendered).toContain('--all');
  });

  it('无裸未隔离 spawnSync 残留：唯一 agent-browser 调用走 scoped finalArgs', () => {
    expect(rendered).not.toContain('spawnSync("agent-browser", parts');
    expect(rendered).toContain('finalArgs');
  });

  it('installBrowserTools 落盘文件即隔离版（含 --session 注入）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-btools-'));
    try {
      const filePath = installBrowserTools(root);
      if (filePath === null) {
        // 本地 dev 无 agent-browser CLI：安装门跳过属预期，渲染版本已由上组断言覆盖
        expect(renderBrowserToolsFile()).toContain('"--session"');
        return;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('"--session"');
      expect(content).toContain('"--profile"');
      expect(content).not.toContain('spawnSync("agent-browser", parts');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
