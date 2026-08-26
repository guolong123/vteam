import { renderFieldTemplate } from './field-template.util';

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
