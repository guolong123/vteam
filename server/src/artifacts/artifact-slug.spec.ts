import {
  docIdFor,
  prototypeFileName,
  prototypeSlug,
  toSlug,
} from './artifact-slug';

/**
 * slug 规范锁（T3）：`artifact-slug.ts` 为 server 侧唯一定义，深链 `?doc=` 兼容。
 * 用例覆盖空格/中文/纯符号/大小写/重名去重/空标题/超长/数字 + 原型命名。
 */
describe('artifact-slug', () => {
  it('空格：收尾裁剪 + 连续分隔折叠', () => {
    expect(toSlug('  Hello   World  ')).toBe('hello-world');
    expect(toSlug(' leading-and-trailing- ')).toBe('leading-and-trailing');
  });

  it('纯中文标题：slug 兜底 doc，docId 追加 artifact 后缀', () => {
    expect(toSlug('需求文档')).toBe('doc');
    expect(docIdFor('需求文档', 'art_1')).toBe('doc-art1');
  });

  it('纯符号标题：与空标题同等兜底', () => {
    expect(toSlug('!!!')).toBe('doc');
    expect(toSlug('---')).toBe('doc');
    expect(docIdFor('!!!', 'art_0000000002')).toBe('doc-00000002');
  });

  it('大小写：统一折叠为小写', () => {
    expect(toSlug('Architecture Design')).toBe('architecture-design');
    expect(toSlug('UPPER CASE TITLE')).toBe('upper-case-title');
    expect(docIdFor('Architecture', 'art_2')).toBe('architecture');
  });

  it('重名去重：弱 slug 按 artifact 区分，强 slug 纯函数稳定', () => {
    const a = docIdFor('需求文档', 'art_0000000001');
    const b = docIdFor('需求文档', 'art_0000000002');
    expect(a).toBe('doc-00000001');
    expect(b).toBe('doc-00000002');
    expect(a).not.toBe(b);
    // 强 slug 与 artifact 无关（同名强 slug 冲突由调用方去重集处理）
    expect(docIdFor('Design Doc', 'art_0000000001')).toBe(
      docIdFor('Design Doc', 'art_0000000002'),
    );
  });

  it('空标题：兜底 doc + 后缀', () => {
    expect(toSlug('')).toBe('doc');
    expect(toSlug('   ')).toBe('doc');
    expect(docIdFor('', 'art_9')).toBe('doc-art9');
  });

  it('超长标题：不截断，原样折叠', () => {
    const long = 'a'.repeat(500);
    expect(toSlug(long)).toBe(long);
  });

  it('数字标题：数字保留为有效 slug', () => {
    expect(toSlug('123 456')).toBe('123-456');
    expect(toSlug('0')).toBe('0');
    expect(docIdFor('0', 'art_1')).toBe('0');
  });

  it('下划线/点号：统一折叠为连字符（与原型命名区分）', () => {
    expect(toSlug('my_doc')).toBe('my-doc');
    expect(toSlug('my.doc')).toBe('my-doc');
    expect(toSlug('混合 Mix 中文 Title')).toBe('mix-title');
  });

  it('弱词 doc 作标题：同样走后缀防冲突', () => {
    expect(toSlug('doc')).toBe('doc');
    expect(docIdFor('doc', 'art_1')).toBe('doc-art1');
    expect(docIdFor('Doc', 'art_1')).toBe('doc-art1');
  });

  it('prototypeSlug：优先文件名去 .tsx（大小写不敏感），保留下划线', () => {
    expect(
      prototypeSlug('My Demo', 'art_0000000001', '/uploads/My Demo.tsx'),
    ).toBe('my-demo');
    expect(prototypeSlug('D', 'x', '/uploads/my-proto_v2.TSX')).toBe(
      'my-proto_v2',
    );
  });

  it('prototypeSlug：中文/空文件名回退标题，弱名追加 proto 后缀', () => {
    expect(
      prototypeSlug('中文原型', 'art_0000000002', '/uploads/中文原型.tsx'),
    ).toBe('proto-00000002');
    expect(prototypeSlug('t', 'art_1', '/uploads/.tsx')).toBe('t');
    expect(prototypeSlug('doc', 'art_9', '/uploads/!!!.tsx')).toBe(
      'proto-art9',
    );
  });

  it('prototypeFileName：去 .prototype.json→.json，弱名同规则', () => {
    expect(
      prototypeFileName(
        'My Proto',
        'art_0000000001',
        '/uploads/my-proto.prototype.json',
      ),
    ).toBe('my-proto.json');
    expect(
      prototypeFileName('中文', 'art_0000000002', '/uploads/中文.json'),
    ).toBe('proto-00000002.json');
    expect(prototypeFileName('doc', 'art_9', '/uploads/!!!.json')).toBe(
      'proto-art9.json',
    );
    expect(
      prototypeFileName('D', 'UPPERID1234567890abcdef', '/uploads/plain.JSON'),
    ).toBe('plain.json');
  });
});
