/**
 * filename-encoding 单测：multipart 文件名 latin1/UTF-8 错位修复。
 *
 * 复现口径与浏览器一致：中文按 UTF-8 字节写进 multipart `filename=`，
 * busboy 默认 latin1 解码 ⇒ 每个汉字变成 2~3 个 U+0080–U+00FF 字符（乱码）。
 */
import { repairMultipartText } from './filename-encoding';

/** 模拟 busboy 把 UTF-8 文件名按 latin1 解码后的形态。 */
function asBusboyLatin1(original: string): string {
  return Buffer.from(original, 'utf8').toString('latin1');
}

describe('repairMultipartText（multipart 文件名编码修复）', () => {
  it('中文文件名被 latin1 解码 → 还原为原文件名', () => {
    const garbled = asBusboyLatin1('需求说明.md');
    expect(garbled).not.toBe('需求说明.md'); // 前置：确实是乱码形态
    expect(repairMultipartText(garbled)).toBe('需求说明.md');
  });

  it('修复幂等：对已修复的字符串再次调用不改变结果', () => {
    const garbled = asBusboyLatin1('测试用例-v2.docx');
    const once = repairMultipartText(garbled);
    expect(once).toBe('测试用例-v2.docx');
    expect(repairMultipartText(once)).toBe('测试用例-v2.docx');
  });

  it('已正确的中文（含 > 0xFF 码位）原样返回', () => {
    expect(repairMultipartText('需求说明.md')).toBe('需求说明.md');
  });

  it('真正的 latin1 文本（café.md，单字节不是合法 UTF-8 序列）原样返回', () => {
    expect(repairMultipartText('café.md')).toBe('café.md');
    expect(repairMultipartText('résumé.pdf')).toBe('résumé.pdf');
  });

  it('纯 ASCII / 空串 原样返回（绝大多数文件的快速路径）', () => {
    expect(repairMultipartText('README.md')).toBe('README.md');
    expect(repairMultipartText('')).toBe('');
  });

  it('混合：中文 + ASCII 扩展名同样还原', () => {
    expect(repairMultipartText(asBusboyLatin1('架构图-2026.png'))).toBe(
      '架构图-2026.png',
    );
  });
});
