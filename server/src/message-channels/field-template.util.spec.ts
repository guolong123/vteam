import {
  evaluateFilter,
  extractVariables,
  renderMessageTemplate,
  renderFieldTemplate,
} from './field-template.util';

describe('field-template.util', () => {
  it('renders {{ path }} extraction with a.b.c', () => {
    const data = { body: { content: 'hello' }, user: { name: 'Alice' } };
    expect(renderFieldTemplate('{{ body.content }}', data)).toBe('hello');
    expect(renderFieldTemplate('{{ user.name }}', data)).toBe('Alice');
  });

  it('trims spaces inside braces and handles multiple placeholders', () => {
    const data = {
      repository: { full_name: 'owner/repo' },
      pusher: { name: 'Bob' },
    };
    const tpl =
      '[{{ repository.full_name }}] {{ pusher.name }}: {{ head_commit.message }}';
    const data2 = { ...data, head_commit: { message: 'fix bug' } };
    expect(renderFieldTemplate(tpl, data2)).toBe('[owner/repo] Bob: fix bug');
  });

  it('missing path returns empty string', () => {
    const data = { a: { b: 1 } };
    expect(renderFieldTemplate('{{ a.c }}', data)).toBe('');
    expect(renderFieldTemplate('{{ missing }}', data)).toBe('');
  });

  it('non-string values stringified, null/undefined => empty', () => {
    expect(renderFieldTemplate('{{ count }}', { count: 42 })).toBe('42');
    expect(renderFieldTemplate('{{ flag }}', { flag: true })).toBe('true');
    expect(renderFieldTemplate('{{ missing }}', {})).toBe('');
  });

  it('mixed literal and template', () => {
    expect(renderFieldTemplate('github', {})).toBe('github');
    expect(
      renderFieldTemplate('prefix-{{ a.b }}-suffix', { a: { b: 'X' } }),
    ).toBe('prefix-X-suffix');
  });
});

describe('extractVariables / renderMessageTemplate / evaluateFilter', () => {
  it('extractVariables: name←path 提取，缺失回退 fallback', () => {
    const data = { issue: { title: 'T' } };
    const vars = [
      { name: 't', path: 'issue.title' },
      { name: 'n', path: 'issue.number', fallback: '-' },
    ];
    expect(extractVariables(vars, data)).toEqual({ t: 'T', n: '-' });
  });

  it('extractVariables: 数字转字符串', () => {
    expect(
      extractVariables([{ name: 'n', path: 'count' }], { count: 42 }),
    ).toEqual({ n: '42' });
    expect(
      extractVariables([{ name: 'f', path: 'flag' }], { flag: true }),
    ).toEqual({ f: 'true' });
  });

  it('renderMessageTemplate: {{name}} 纯插值（变量表外路径→空串）', () => {
    const data = { a: { b: 'X' }, c: { d: 'Y' } };
    const vars = [
      { name: 'b', path: 'a.b' },
      { name: 'd', path: 'c.d' },
    ];
    expect(
      renderMessageTemplate('[{{b}}] {{d}} {{missing}} {{a.b}}', vars, data),
    ).toBe('[X] Y  ');
  });

  it('renderMessageTemplate: 空模板/空变量表', () => {
    expect(renderMessageTemplate('', [{ name: 'x', path: 'a' }], {})).toBe('');
    expect(renderMessageTemplate('{{x}}', [], {})).toBe('');
  });

  it('evaluateFilter: and 命中放行', () => {
    const r = evaluateFilter(
      [
        {
          logic: 'and',
          conditions: [{ path: 'a', op: 'eq', value: '1' }],
          action: 'deliver',
        },
      ],
      'discard',
      { a: '1' },
    );
    expect(r.action).toBe('deliver');
    expect(r.matchedRule).toBeTruthy();
  });

  it('evaluateFilter: 无命中用默认动作（丢弃）', () => {
    const r = evaluateFilter([], 'discard', {});
    expect(r.action).toBe('discard');
    expect(r.matchedRule).toBeUndefined();
  });

  it('evaluateFilter: or 逻辑；缺失字段不抛异常', () => {
    const r = evaluateFilter(
      [
        {
          logic: 'or',
          conditions: [
            { path: 'missing.field', op: 'exists' },
            { path: 'a', op: 'eq', value: '1' },
          ],
          action: 'discard',
        },
      ],
      'deliver',
      { a: '1' },
    );
    expect(r.action).toBe('discard');
  });

  it('evaluateFilter: 非法正则不抛异常（匹配 false）', () => {
    const r = evaluateFilter(
      [
        {
          logic: 'and',
          conditions: [{ path: 'a', op: 'regex', value: '[' }],
          action: 'deliver',
        },
      ],
      'discard',
      { a: 'x' },
    );
    expect(r.action).toBe('discard');
  });
});
