/**
 * worker 侧产出物文件收集单测（P2/P3：doc/file 自动归档链路）。
 *
 * 覆盖：
 * - extractFileArtifacts：JSON 声明 / <artifact> 标签提取、type/title/fileRef 校验、
 *   去重、非法声明不误报、text 类型不提取（由 server 端处理）
 * - collectFileArtifacts：绝对/相对 fileRef 读文件内容、文件不存在 → 保留占位、
 *   外部 URL / /uploads/ 引用跳过、超限跳过、读取失败不抛错
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ARTIFACT_FILE_BYTES,
  collectFileArtifacts,
  extractFileArtifacts,
} from './artifact-extract';

describe('extractFileArtifacts（doc/file 声明提取）', () => {
  it('JSON 声明（type=doc/file）→ 提取', () => {
    const text =
      '我已创建文档。' +
      '{"type":"doc","title":"需求文档","fileRef":"/tmp/opencode/req.md"}';
    expect(extractFileArtifacts(text)).toEqual([
      { type: 'doc', title: '需求文档', fileRef: '/tmp/opencode/req.md' },
    ]);
  });

  it('type=text 的 JSON 声明不提取（text 内容已在回复中，由 server 端提取）', () => {
    const text = '{"type":"text","title":"要点","content":"abc"}';
    expect(extractFileArtifacts(text)).toEqual([]);
  });

  it('<artifact type="doc" title fileRef> 标签 → 提取（属性反转义）', () => {
    const text =
      '<artifact type="doc" title="设计文档" fileRef="docs/design.md">正文</artifact>';
    expect(extractFileArtifacts(text)).toEqual([
      { type: 'doc', title: '设计文档', fileRef: 'docs/design.md' },
    ]);
  });

  it('同一声明重复出现 → 去重', () => {
    const decl = '{"type":"file","title":"补丁","fileRef":"/tmp/x.patch"}';
    expect(extractFileArtifacts(`${decl} 再次声明 ${decl}`)).toHaveLength(1);
  });

  it('缺 title/fileRef 的非法声明不提取（不误报）', () => {
    expect(extractFileArtifacts('{"type":"doc","title":"x"}')).toEqual([]);
    expect(extractFileArtifacts('{"type":"doc","fileRef":"/tmp/x.md"}')).toEqual(
      [],
    );
    expect(extractFileArtifacts('普通文本无声明')).toEqual([]);
  });
});

describe('collectFileArtifacts（读取文件内容）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-extract-'));
  });

  it('绝对 fileRef 存在 → 携带文件内容', async () => {
    const file = join(dir, 'doc.md');
    writeFileSync(file, 'hello artifact', 'utf8');
    const out = await collectFileArtifacts(
      `{"type":"doc","title":"文档","fileRef":"${file}"}`,
      dir,
    );
    expect(out).toEqual([
      { type: 'doc', title: '文档', fileRef: file, content: 'hello artifact' },
    ]);
  });

  it('相对 fileRef（相对工作目录）→ 读工作目录下文件', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'note content', 'utf8');
    const out = await collectFileArtifacts(
      '{"type":"file","title":"笔记","fileRef":"notes.txt"}',
      dir,
    );
    expect(out[0]?.content).toBe('note content');
  });

  it('文件不存在 → 保留 fileRef 占位（不抛错，不阻断回流）', async () => {
    const out = await collectFileArtifacts(
      '{"type":"doc","title":"丢失","fileRef":"/tmp/not-exist-xyz.md"}',
      dir,
    );
    expect(out).toEqual([
      { type: 'doc', title: '丢失', fileRef: '/tmp/not-exist-xyz.md' },
    ]);
    expect(out[0]?.content).toBeUndefined();
  });

  it('外部 URL / /uploads/ 引用 → 跳过读取（保留占位）', async () => {
    const text =
      '{"type":"doc","title":"外链","fileRef":"https://example.com/a.md"}' +
      '{"type":"file","title":"已落盘","fileRef":"/uploads/x.md"}';
    const out = await collectFileArtifacts(text, dir);
    expect(out.every((a) => a.content === undefined)).toBe(true);
  });

  it('文件超限 → 跳过内容（仅占位）', async () => {
    const file = join(dir, 'big.md');
    writeFileSync(file, 'x'.repeat(MAX_ARTIFACT_FILE_BYTES + 1), 'utf8');
    const out = await collectFileArtifacts(
      `{"type":"doc","title":"大文件","fileRef":"${file}"}`,
      dir,
    );
    expect(out[0]?.content).toBeUndefined();
  });

  it('无 doc/file 声明 → 返回空数组', async () => {
    expect(await collectFileArtifacts('普通回复', dir)).toEqual([]);
  });
});
