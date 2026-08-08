import { BadRequestException } from '@nestjs/common';
import { SKILL_ERRORS } from '../common/constants/skill.constants';
import {
  assertSkillName,
  parseSkillMarkdown,
} from './skill-frontmatter.util';

describe('parseSkillMarkdown（SKILL.md frontmatter 解析）', () => {
  it('标量 + 块标量 + 列表：完整解析，content 保留原文', () => {
    const raw = [
      '---',
      'name: ketacli',
      'version: 1.0.0',
      'description: |',
      '  KetaDB CLI 统一入口 — 管理日志/指标查询。',
      '  second line',
      'allowed-tools:',
      '  - Bash',
      '  - Read',
      '---',
      '# ketacli',
      '',
      '正文内容',
    ].join('\n');

    const { frontmatter, content } = parseSkillMarkdown(raw);

    expect(frontmatter).toEqual({
      name: 'ketacli',
      version: '1.0.0',
      description: 'KetaDB CLI 统一入口 — 管理日志/指标查询。\nsecond line',
      'allowed-tools': ['Bash', 'Read'],
    });
    expect(content).toBe(raw);
  });

  it('内联流式列表 allowed-tools: [a, b]', () => {
    const raw = '---\nname: git-ops\nallowed-tools: [Bash, Read]\n---\n';

    const { frontmatter } = parseSkillMarkdown(raw);

    expect(frontmatter['allowed-tools']).toEqual(['Bash', 'Read']);
  });

  it('带引号值剥离引号', () => {
    const raw = '---\nname: "git-ops"\ndescription: \'双引号测试\'\n---\n';

    const { frontmatter } = parseSkillMarkdown(raw);

    expect(frontmatter.name).toBe('git-ops');
    expect(frontmatter.description).toBe('双引号测试');
  });

  it('缺省字段与未知字段：未知忽略、缺省 undefined', () => {
    const raw = '---\nname: git-ops\nx-extra: foo\n---\n';

    const { frontmatter } = parseSkillMarkdown(raw);

    expect(frontmatter).toEqual({ name: 'git-ops' });
    expect(frontmatter.version).toBeUndefined();
    expect(frontmatter.description).toBeUndefined();
  });

  it('首行非 ---（非技能包）→ 400 SKILL_FRONTMATTER_INVALID', () => {
    const raw = '# 纯 markdown 无 frontmatter\n';

    expect(() => parseSkillMarkdown(raw)).toThrow(BadRequestException);
    try {
      parseSkillMarkdown(raw);
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({
        code: SKILL_ERRORS.SKILL_FRONTMATTER_INVALID,
      });
    }
  });

  it('无结束标记 --- → 400 SKILL_FRONTMATTER_INVALID', () => {
    expect(() => parseSkillMarkdown('---\nname: git-ops\n')).toThrow(
      BadRequestException,
    );
  });

  it('CRLF 行尾兼容', () => {
    const raw = '---\r\nname: git-ops\r\n---\r\n正文\r\n';

    const { frontmatter } = parseSkillMarkdown(raw);

    expect(frontmatter.name).toBe('git-ops');
  });
});

describe('assertSkillName（frontmatter name 校验）', () => {
  it('合法 name 通过并返回 trim 后值', () => {
    expect(assertSkillName({ name: 'git-ops' })).toBe('git-ops');
    expect(assertSkillName({ name: 'ketacli' })).toBe('ketacli');
    expect(assertSkillName({ name: 'a1-b2-c3' })).toBe('a1-b2-c3');
  });

  it('缺 name → 400 SKILL_FRONTMATTER_INVALID', () => {
    try {
      assertSkillName({ version: '1.0.0' });
      fail('应抛 400');
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({
        code: SKILL_ERRORS.SKILL_FRONTMATTER_INVALID,
      });
    }
  });

  it('非法格式（大写/空格/首尾中划线）→ 400', () => {
    for (const bad of ['GitOps', 'git ops', '-git', 'git-', 'git..ops']) {
      expect(() => assertSkillName({ name: bad })).toThrow(BadRequestException);
    }
  });

  it('超长 name（> 64）→ 400', () => {
    expect(() =>
      assertSkillName({ name: 'a'.repeat(65) }),
    ).toThrow(BadRequestException);
  });
});
