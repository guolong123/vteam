import { getSessionScope, isMemberSessionScope } from './session-scope';

describe('SESSION_SCOPE 开关', () => {
  const original = process.env.SESSION_SCOPE;

  afterEach(() => {
    if (original === undefined) delete process.env.SESSION_SCOPE;
    else process.env.SESSION_SCOPE = original;
  });

  it('未设置/其他值 → seat（默认旧路径）', () => {
    delete process.env.SESSION_SCOPE;
    expect(getSessionScope()).toBe('seat');
    expect(isMemberSessionScope()).toBe(false);
    process.env.SESSION_SCOPE = 'seat';
    expect(getSessionScope()).toBe('seat');
    process.env.SESSION_SCOPE = 'weird';
    expect(getSessionScope()).toBe('seat');
  });

  it('member（忽略大小写/空白）→ member', () => {
    process.env.SESSION_SCOPE = ' MEMBER ';
    expect(getSessionScope()).toBe('member');
    expect(isMemberSessionScope()).toBe(true);
  });
});
