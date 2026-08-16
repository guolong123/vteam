import { PERSONA_LIBRARY, renderPersonaSection } from './persona.constants';

describe('persona.constants', () => {
  describe('PERSONA_LIBRARY', () => {
    it('含 5 个预设性格 key（steady/strict/aggressive/conservative/innovative）', () => {
      expect(Object.keys(PERSONA_LIBRARY).sort()).toEqual(
        ['aggressive', 'conservative', 'innovative', 'steady', 'strict'].sort(),
      );
    });

    it('每条性格文案非空且可被 renderPersonaSection 渲染', () => {
      for (const key of Object.keys(PERSONA_LIBRARY)) {
        expect(PERSONA_LIBRARY[key as keyof typeof PERSONA_LIBRARY].length).toBeGreaterThan(0);
        expect(renderPersonaSection(key)).toContain('## 性格');
      }
    });
  });

  describe('renderPersonaSection', () => {
    it('命中库：返回以 `\\n## 性格\\n` 开头的段文案', () => {
      expect(renderPersonaSection('steady')).toBe(
        `\n## 性格\n${PERSONA_LIBRARY.steady}`,
      );
    });

    it('strict 含安全阀文案（每条批评须附改进建议，不纠风格）', () => {
      const s = renderPersonaSection('strict');
      expect(s).toContain('附改进建议');
      expect(s).toContain('只拦实质问题');
    });

    it('aggressive 含安全阀（关键步骤保留验证，不跳过验收）', () => {
      const s = renderPersonaSection('aggressive');
      expect(s).toContain('保留验证');
      expect(s).toContain('不跳过验收');
    });

    it('innovative 含安全阀（新方案须说明权衡）', () => {
      expect(renderPersonaSection('innovative')).toContain('权衡');
    });

    it('未知 / 空 key：返回空串（不抛错），不做大小写归一', () => {
      expect(renderPersonaSection('unknown-key')).toBe('');
      expect(renderPersonaSection('')).toBe('');
      expect(renderPersonaSection('STRICT')).toBe('');
      expect(renderPersonaSection('strict ')).toBe('');
    });
  });
});
