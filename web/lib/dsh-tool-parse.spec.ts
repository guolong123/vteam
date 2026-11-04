/**
 * 工具 I/O 解析层单测（`src/components/chat/dsh/dsh-tool-parse.ts`）
 * =============================================
 * 用**实测到的真实样本**（从试用环境 worker 日志/落库消息里抓的，见各用例注释），
 * 钉死三种格式的解析口径 —— 这些格式是 DSH 工具的输出契约，改版时这里会先红。
 *
 * 为什么放在 `lib/`：web 没有独立的单测运行器，Playwright 的 `lib-unit` project
 * 把 `web/lib/**\/*.spec.ts` 挂进测试套件才会真的被执行。
 */

import { test, expect } from '@playwright/test';
import {
  commandOf,
  diffOfInput,
  langOfPath,
  parseGrepOutput,
  parseReadOutput,
  unwrapContent,
  viewKindOf,
} from '../src/components/chat/dsh/dsh-tool-parse';

test.describe('parseReadOutput（DSH read 文本回执）', () => {
  // 实测样本（读取 pelican-bike.html 前 20 行）
  const sample = [
    '<path>/data/vteam-worker/teams/tm_0000000002/pelican-bike.html</path>',
    '<type>file</type>',
    '<content>',
    '1: <!DOCTYPE html>',
    '2: <html lang="zh-CN">',
    '3:   <head>',
    '</content>',
  ].join('\n');

  test('抽出 path / 行号 / 行文本', () => {
    const parsed = parseReadOutput(sample);
    expect(parsed).not.toBeNull();
    expect(parsed?.path).toBe('/data/vteam-worker/teams/tm_0000000002/pelican-bike.html');
    expect(parsed?.lines).toHaveLength(3);
    expect(parsed?.lines[0]).toEqual({ number: 1, text: '<!DOCTYPE html>' });
    expect(parsed?.lines[2]).toEqual({ number: 3, text: '  <head>' });
    expect(parsed?.totalLines).toBe(3);
  });

  test('type=image 不走 read 视图（交给缩略图）', () => {
    const image = [
      '<path>/x.png</path>',
      '<type>image</type>',
      '<content>image/png image, 960x600 px</content>',
    ].join('\n');
    expect(parseReadOutput(image)).toBeNull();
  });

  test('没有 <content> 外壳 / 不是 read 回执 → null（回退文本）', () => {
    expect(parseReadOutput('just plain text')).toBeNull();
    expect(parseReadOutput('<path>a</path><type>file</type>')).toBeNull();
  });

  test('行文本里含 `<content>` 字样也不会切错（按最外层位置切）', () => {
    const tricky = ['<path>a.md</path>', '<type>file</type>', '<content>', '1: 提到 <content> 标签', '2: 结束', '</content>'].join('\n');
    const parsed = parseReadOutput(tricky);
    expect(parsed?.lines).toHaveLength(2);
    expect(parsed?.lines[0].text).toBe('提到 <content> 标签');
  });
});

test.describe('parseGrepOutput（grep 回执）', () => {
  // 实测样本
  const sample = [
    'Found 4 matches',
    '',
    'teams/tm_0000000002/pelican-carry-bike.html',
    'Line 236:       <g id="pelicanBody">',
    'Line 545:     $(\'pelicanBody\').setAttribute(\'transform\', bodyTransform);',
    '',
    'teams/tm_0000000002/pelican-bike.html',
    'Line 296:       <g id="pelicanBob">',
    'Line 492:     $(\'pelicanBob\').setAttribute(\'transform\',',
  ].join('\n');

  test('按文件分组，保留行号与行文本', () => {
    const parsed = parseGrepOutput(sample);
    expect(parsed).not.toBeNull();
    expect(parsed?.total).toBe(4);
    expect(parsed?.truncated).toBe(false);
    expect(parsed?.files).toHaveLength(2);
    expect(parsed?.files[0].path).toBe('teams/tm_0000000002/pelican-carry-bike.html');
    expect(parsed?.files[0].matches[0]).toEqual({ lineNumber: 236, line: '      <g id="pelicanBody">' });
    expect(parsed?.files[1].matches).toHaveLength(2);
  });

  test('返回条数少于 total → truncated', () => {
    const truncated = ['Found 99 matches', '', 'a.ts', 'Line 1: x'].join('\n');
    const parsed = parseGrepOutput(truncated);
    expect(parsed?.total).toBe(99);
    expect(parsed?.truncated).toBe(true);
  });

  test('无 "Found" 头 → null（回退文本）', () => {
    expect(parseGrepOutput('teams/a.html\nLine 1: x')).toBeNull();
  });
});

test.describe('commandOf（bash 入参提命令）', () => {
  test('取 command 字段', () => {
    expect(commandOf('{"description":"List","command":"ls -la /data"}')).toBe('ls -la /data');
  });
  test('兼容 cmd 字段', () => {
    expect(commandOf('{"cmd":"pwd"}')).toBe('pwd');
  });
  test('非 JSON / 无命令 → null', () => {
    expect(commandOf('ls -la')).toBeNull();
    expect(commandOf('{"description":"x"}')).toBeNull();
    expect(commandOf('{"command":"   "}')).toBeNull();
  });
});

test.describe('diffOfInput（编辑类工具的 diff 从入参构造）', () => {
  test('edit：old_string / new_string', () => {
    const diffs = diffOfInput('{"file_path":"/a.ts","old_string":"a","new_string":"b"}');
    expect(diffs).toEqual([{ path: '/a.ts', oldText: 'a', newText: 'b' }]);
  });

  test('write：无旧内容 → oldText=null', () => {
    const diffs = diffOfInput('{"file_path":"/a.ts","content":"hello"}');
    expect(diffs).toEqual([{ path: '/a.ts', oldText: null, newText: 'hello' }]);
  });

  test('多编辑 edits[]', () => {
    const diffs = diffOfInput('{"file_path":"/a.ts","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}');
    expect(diffs).toHaveLength(2);
    expect(diffs?.[1]).toEqual({ path: '/a.ts', oldText: 'c', newText: 'd' });
  });

  test('无编辑信息 → null', () => {
    expect(diffOfInput('{"file_path":"/a.ts"}')).toBeNull();
  });
});

test.describe('viewKindOf + langOfPath', () => {
  const readOut = '<path>/a.html</path>\n<type>file</type>\n<content>\n1: x\n</content>';

  test('按工具名分类', () => {
    expect(viewKindOf('bash', '')).toBe('terminal');
    expect(viewKindOf('vteam_run_command', '')).toBe('terminal');
    expect(viewKindOf('grep', '')).toBe('search');
    expect(viewKindOf('write', '')).toBe('diff');
    expect(viewKindOf('edit', '')).toBe('diff');
    expect(viewKindOf('read', readOut)).toBe('read');
  });

  test('名字认不出时按输出形态兜底', () => {
    expect(viewKindOf('vteam_something', readOut)).toBe('read');
  });

  test('langOfPath 认扩展名，未知返回 undefined', () => {
    expect(langOfPath('/a/b.html')).toBe('html');
    expect(langOfPath('/a/b.ts')).toBe('typescript');
    expect(langOfPath('/a/b.unknownext')).toBeUndefined();
  });
});

test.describe('unwrapContent', () => {
  test('剥掉外壳只留正文', () => {
    expect(unwrapContent('<content>\nline1\nline2\n</content>')).toBe('line1\nline2');
  });
  test('没有外壳 → 原样返回', () => {
    expect(unwrapContent('plain')).toBe('plain');
  });
});
