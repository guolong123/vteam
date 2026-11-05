/**
 * message-attachments 单测：附件数组归一化（新列优先 / 旧三字段回退 / 去重 / 截断 /
 * 文件名编码修复）。
 */
import {
  legacyAttachmentFields,
  MAX_MESSAGE_ATTACHMENTS,
  normalizeAttachmentList,
  normalizeMessageAttachments,
  toStoredAttachments,
} from './message-attachments';

/** 模拟 busboy 把 UTF-8 文件名按 latin1 解码后的形态（历史脏数据）。 */
function asBusboyLatin1(original: string): string {
  return Buffer.from(original, 'utf8').toString('latin1');
}

describe('normalizeAttachmentList', () => {
  it('合法数组原样归一：补齐 ext、保留 size、丢弃非法条目', () => {
    const list = normalizeAttachmentList([
      { url: '/uploads/a.png', name: '截图.png', size: 1234, ext: 'PNG' },
      { url: '/uploads/b.zip', name: '源码.zip', size: 999 },
      null,
      { name: '没有 url' },
      { url: '   ' },
    ]);
    expect(list).toEqual([
      { url: '/uploads/a.png', name: '截图.png', size: 1234, ext: 'png' },
      { url: '/uploads/b.zip', name: '源码.zip', size: 999, ext: 'zip' },
    ]);
  });

  it('按 url 去重 + 截断到 MAX_MESSAGE_ATTACHMENTS', () => {
    const raw = Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 3 }, (_, i) => ({
      url: `/uploads/${i}.txt`,
      name: `${i}.txt`,
    }));
    raw.push({ url: '/uploads/0.txt', name: '重复.txt' });
    const list = normalizeAttachmentList(raw);
    expect(list).toHaveLength(MAX_MESSAGE_ATTACHMENTS);
    expect(list[0]).toMatchObject({ url: '/uploads/0.txt', name: '0.txt' });
    expect(list.map((x) => x.url)).not.toContain('/uploads/0.txt'.repeat(2));
  });

  it('历史脏数据：文件名 latin1/UTF-8 错位在读取侧修复（幂等）', () => {
    const garbled = asBusboyLatin1('需求说明.md');
    const list = normalizeAttachmentList([
      { url: '/uploads/u1.md', name: garbled, ext: 'md' },
    ]);
    expect(list[0].name).toBe('需求说明.md');
    expect(list[0].ext).toBe('md');
    // 二次归一（已修复）不再变化
    expect(normalizeAttachmentList(list)[0].name).toBe('需求说明.md');
  });

  it('非数组 / 空数组 → []', () => {
    expect(normalizeAttachmentList(undefined)).toEqual([]);
    expect(normalizeAttachmentList(null)).toEqual([]);
    expect(normalizeAttachmentList([])).toEqual([]);
    expect(normalizeAttachmentList('oops')).toEqual([]);
  });
});

describe('normalizeMessageAttachments', () => {
  it('新列 attachments 优先于旧三字段', () => {
    const list = normalizeMessageAttachments({
      attachments: [
        { url: '/uploads/new1.png', name: 'new1.png', ext: 'png' },
        { url: '/uploads/new2.zip', name: 'new2.zip', ext: 'zip' },
      ],
      attachmentUrl: '/uploads/legacy.png',
      attachmentName: 'legacy.png',
      attachmentType: 'png',
    });
    expect(list.map((x) => x.url)).toEqual([
      '/uploads/new1.png',
      '/uploads/new2.zip',
    ]);
  });

  it('新列缺失/为空 → 旧三字段回退单元素（历史行兼容）', () => {
    expect(
      normalizeMessageAttachments({
        attachments: null,
        attachmentUrl: '/uploads/legacy.png',
        attachmentName: '旧图.png',
        attachmentType: 'png',
      }),
    ).toEqual([{ url: '/uploads/legacy.png', name: '旧图.png', ext: 'png' }]);
    expect(
      normalizeMessageAttachments({
        attachments: [],
        attachmentUrl: '/uploads/legacy.pdf',
        attachmentName: '旧文档.pdf',
        attachmentType: 'pdf',
      }),
    ).toHaveLength(1);
  });

  it('无任何附件 → []', () => {
    expect(normalizeMessageAttachments({})).toEqual([]);
  });
});

describe('toStoredAttachments / legacyAttachmentFields', () => {
  it('落库形状：剔除 undefined size；空数组 → undefined（不写列）', () => {
    expect(toStoredAttachments([])).toBeUndefined();
    expect(
      toStoredAttachments([
        { url: '/uploads/a.png', name: 'a.png', ext: 'png', size: 5 },
        { url: '/uploads/b.zip', name: 'b.zip', ext: 'zip' },
      ]),
    ).toEqual([
      { url: '/uploads/a.png', name: 'a.png', ext: 'png', size: 5 },
      { url: '/uploads/b.zip', name: 'b.zip', ext: 'zip' },
    ]);
  });

  it('旧三字段 = 首个附件投影；空数组 → 空对象', () => {
    expect(
      legacyAttachmentFields([
        { url: '/uploads/a.png', name: 'a.png', ext: 'png' },
        { url: '/uploads/b.zip', name: 'b.zip', ext: 'zip' },
      ]),
    ).toEqual({
      attachmentUrl: '/uploads/a.png',
      attachmentName: 'a.png',
      attachmentType: 'png',
    });
    expect(legacyAttachmentFields([])).toEqual({});
  });
});
