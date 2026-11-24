import { signUploadUrl, verifyUploadUrlSignature } from './uploads.constants';
import { promises as fsp } from 'fs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { ForbiddenException } from '@nestjs/common';
import { FileStorageService } from './uploads.service';
import {
  resolveUploadDir,
  uploadRelativePathOf,
  uploadUrlPath,
  uploadWorkspaceSegment,
} from './uploads.constants';
import { runWithTenant } from '../common/tenant/tenant-context';

/**
 * M2-3：上传文件按空间分区。
 * - 落盘目录 `<根>/workspaces/<ws>/`、URL `/uploads/workspaces/<ws>/<file>`；
 * - 读文件时校验空间（跨空间读 → 403）；
 * - 存量 `/uploads/<file>` 仍可读（迁移期兼容）。
 */
describe('uploads 空间分区（M2-3）', () => {
  let root: string;
  const prevUploadDir = process.env.UPLOAD_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uploads-ws-'));
    // 用相对路径，避免 resolveUploadDir 的 join(cwd, 绝对路径) 在仓库内造出 var/ 目录
    process.env.UPLOAD_DIR = relative(process.cwd(), root);
  });

  afterEach(() => {
    process.env.UPLOAD_DIR = prevUploadDir;
  });

  it('workspace 目录名做安全清洗，空值回落 default', () => {
    expect(uploadWorkspaceSegment('ws_a')).toBe('ws_a');
    expect(uploadWorkspaceSegment('../etc/passwd')).toBe('etc-passwd');
    expect(uploadWorkspaceSegment('')).toBe('default');
  });

  it('resolveUploadDir / uploadUrlPath 按空间分区；无空间保持旧路径', () => {
    expect(resolveUploadDir()).toBe(root);
    expect(resolveUploadDir('ws_a')).toBe(join(root, 'workspaces', 'ws_a'));
    expect(uploadUrlPath('f.txt')).toBe('/uploads/f.txt');
    expect(uploadUrlPath('f.txt', 'ws_a')).toBe(
      '/uploads/workspaces/ws_a/f.txt',
    );
    expect(uploadRelativePathOf('/uploads/workspaces/ws_a/f.txt')).toBe(
      'workspaces/ws_a/f.txt',
    );
  });

  it('saveTextFile 在租户上下文内落盘到本空间目录，URL 带空间段', async () => {
    const meta = await runWithTenant(
      { workspaceId: 'ws_a', mode: 'request' },
      () => FileStorageService.saveTextFile('hello', '说明.md'),
    );
    // 空间分区 URL 带签名（?exp&sig），路径部分仍按空间段
    expect(meta.url.split('?')[0]).toMatch(
      /^\/uploads\/workspaces\/ws_a\/.+__说明\.md$/,
    );
    expect(meta.url).toMatch(/\?exp=\d+&sig=[0-9a-f]{32}$/);
    const rel = uploadRelativePathOf(meta.url)!;
    const content = await fsp.readFile(join(resolveUploadDir(), rel), 'utf8');
    expect(content).toBe('hello');
  });

  it('readUploadedFile 跨空间读取 → 403', async () => {
    const dir = join(resolveUploadDir(), 'workspaces', 'ws_b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'secret.txt'), 'b-only');

    await expect(
      runWithTenant({ workspaceId: 'ws_a', mode: 'request' }, () =>
        FileStorageService.readUploadedFile(
          '/uploads/workspaces/ws_b/secret.txt',
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('readUploadedFile 本空间读取正常', async () => {
    const dir = join(resolveUploadDir(), 'workspaces', 'ws_a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.txt'), 'a-file');

    const buf = await runWithTenant(
      { workspaceId: 'ws_a', mode: 'request' },
      () =>
        FileStorageService.readUploadedFile('/uploads/workspaces/ws_a/ok.txt'),
    );
    expect(buf.toString('utf8')).toBe('a-file');
  });

  it('存量 /uploads/<file>（无空间段）在上下文内仍可读（迁移期兼容）', async () => {
    const baseDir = resolveUploadDir();
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, 'legacy.txt'), 'old-file');
    const buf = await runWithTenant(
      { workspaceId: 'ws_a', mode: 'request' },
      () => FileStorageService.readUploadedFile('/uploads/legacy.txt'),
    );
    expect(buf.toString('utf8')).toBe('old-file');
  });

  it('normalizeFileRef 在上下文内把 worker 裸路径映射到本空间 URL', async () => {
    await runWithTenant({ workspaceId: 'ws_a', mode: 'request' }, () => {
      expect(
        FileStorageService.normalizeFileRef('/tmp/worker/a.md').split('?')[0],
      ).toBe('/uploads/workspaces/ws_a/a.md');
    });
    // 无上下文保持旧口径（/uploads/<basename>）
    expect(FileStorageService.normalizeFileRef('/tmp/worker/a.md')).toBe(
      '/uploads/a.md',
    );
  });

  describe('上传 URL 签名（M3 安全收口）', () => {
    it('空间分区 URL 带 exp/sig，校验通过；篡改/过期/无签名一律拒绝', () => {
      const raw = '/uploads/workspaces/ws_a/abc__f.txt';
      const signed = signUploadUrl(raw);
      expect(signed).toMatch(
        /^\/uploads\/workspaces\/ws_a\/abc__f\.txt\?exp=\d+&sig=[0-9a-f]{32}$/,
      );

      const q = Object.fromEntries(
        new URLSearchParams(signed.split('?')[1]).entries(),
      );
      expect(verifyUploadUrlSignature(raw, q)).toBe(true);
      expect(verifyUploadUrlSignature(raw, { ...q, sig: 'f'.repeat(32) })).toBe(
        false,
      );
      expect(
        verifyUploadUrlSignature('/uploads/workspaces/ws_a/other.txt', q),
      ).toBe(false);
      expect(verifyUploadUrlSignature(raw, { ...q, exp: '1000' })).toBe(false);
      expect(verifyUploadUrlSignature(raw, {})).toBe(false);
      expect(signUploadUrl(signed)).toBe(signed);
    });

    it('存量根目录 URL 不签名、不拦截（兼容旧数据）', () => {
      const legacy = '/uploads/abc.pdf';
      expect(signUploadUrl(legacy)).toBe(legacy);
      expect(verifyUploadUrlSignature(legacy, {})).toBe(true);
    });

    it('相对路径解析忽略查询串', () => {
      expect(
        uploadRelativePathOf('/uploads/workspaces/ws_a/f.txt?exp=1&sig=x'),
      ).toBe('workspaces/ws_a/f.txt');
    });
  });
});
