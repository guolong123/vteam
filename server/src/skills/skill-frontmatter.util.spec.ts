import { BadRequestException } from '@nestjs/common';
import { SKILL_ERRORS } from '../common/constants/skill.constants';
import {
  assertSkillName,
  parseSkillMarkdown,
  rewriteFrontmatterField,
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

describe('rewriteFrontmatterField（PATCH 编辑元信息时同步重写 content frontmatter）', () => {
  it('标量 name 已存在 → 整行替换（其余行原样保留）', () => {
    const raw = '---\nname: git-ops\nversion: 1.0.0\n---\n# git-ops';

    const out = rewriteFrontmatterField(raw, 'name', 'git-ops-v2');

    expect(out).toBe('---\nname: git-ops-v2\nversion: 1.0.0\n---\n# git-ops');
  });

  it('description 为块标量 → 替换整块（含缩进续行）', () => {
    const raw = [
      '---',
      'name: git-ops',
      'description: |',
      '  第一行',
      '  第二行',
      '---',
      '# git-ops',
    ].join('\n');

    const out = rewriteFrontmatterField(raw, 'description', '新描述');

    expect(out).toBe('---\nname: git-ops\ndescription: 新描述\n---\n# git-ops');
  });

  it('frontmatter 内缺省字段 → 追加到结束 --- 之前', () => {
    const raw = '---\nname: git-ops\n---\n# git-ops';

    const out = rewriteFrontmatterField(raw, 'description', '新描述');

    expect(out).toBe('---\nname: git-ops\ndescription: 新描述\n---\n# git-ops');
  });

  it('value 为 null → 删除该字段（连块标量续行）', () => {
    const raw = '---\nname: git-ops\ndescription: |\n  说明\n---\n';

    const out = rewriteFrontmatterField(raw, 'description', null);

    expect(out).toBe('---\nname: git-ops\n---\n');
  });

  it('value 为 null 且字段本身缺省 → 原样返回', () => {
    const raw = '---\nname: git-ops\n---\n';

    expect(rewriteFrontmatterField(raw, 'description', null)).toBe(raw);
  });

  it('非合法 SKILL.md（首行非 ---）→ 原样返回不抛错', () => {
    const raw = '# 纯 markdown';

    expect(rewriteFrontmatterField(raw, 'name', 'git-ops')).toBe(raw);
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
    expect(() => assertSkillName({ name: 'a'.repeat(65) })).toThrow(
      BadRequestException,
    );
  });
});
