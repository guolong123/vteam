import { z } from 'zod';
import {
  buildPlatformMcpTools,
  describeToolEnums,
  enumValuesOf,
  withEnumCatalogue,
  zodObjectToJsonSchema,
} from './platform-mcp.tools';
import type { PlatformMcpService } from './platform-mcp.service';

/**
 * 缺陷 4：工具枚举参数在调用前不可见 —— 合法取值只能从运行时校验报错
 * （expected one of ...）里得知。
 *
 * 修复：工具描述首行由 **同一份 zod schema** 派生出枚举全集行，且 tools/list 的
 * inputSchema 附带 enum 取值。本 spec 断言两件事：
 * ① 每个带枚举参数的工具，描述里含该枚举的**完整取值集合**；
 * ② 描述是**派生**的 —— 改 schema 的枚举，描述随之改变（不会漂移）。
 */
describe('platform MCP 工具枚举可见性（缺陷 4）', () => {
  const service = {} as unknown as PlatformMcpService;

  it('每个带枚举参数的工具，描述首行都列出该枚举的完整取值集合', () => {
    const tools = buildPlatformMcpTools(service);
    let checked = 0;
    for (const tool of tools) {
      const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
      const enumParams = Object.entries(shape).filter(([, field]) =>
        enumValuesOf(field as z.ZodTypeAny),
      );
      if (enumParams.length === 0) continue;
      checked += 1;
      const firstLine = tool.description.split('\n')[0];
      expect(firstLine.startsWith('【参数枚举全集】')).toBe(true);
      for (const [key, field] of enumParams) {
        const values = enumValuesOf(field as z.ZodTypeAny)!;
        expect(firstLine).toContain(`${key}: ${values.join(' | ')}`);
        for (const value of values) {
          expect(tool.description).toContain(value);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('描述里的枚举清单由 schema 派生：改 schema 的枚举，描述随之改变', () => {
    const schemaA = z.object({
      mode: z.enum(['alpha', 'beta']),
    });
    const schemaB = z.object({
      mode: z.enum(['alpha', 'gamma']),
    });
    const descA = withEnumCatalogue('工具说明', schemaA);
    const descB = withEnumCatalogue('工具说明', schemaB);
    expect(descA).toContain('mode: alpha | beta');
    expect(descA).not.toContain('gamma');
    expect(descB).toContain('mode: alpha | gamma');
    expect(descB).not.toContain('beta');
    expect(descA).not.toBe(descB);
  });

  it('枚举清单行取自 zod 事实（optional 包裹的枚举同样可枚举出）', () => {
    const schema = z.object({
      required: z.enum(['x', 'y']),
      optional: z.enum(['p', 'q']).optional(),
      plain: z.string(),
    });
    expect(enumValuesOf(schema.shape.required)).toEqual(['x', 'y']);
    expect(enumValuesOf(schema.shape.optional)).toEqual(['p', 'q']);
    expect(enumValuesOf(schema.shape.plain)).toBeNull();
    expect(describeToolEnums(schema)).toBe(
      '【参数枚举全集】required: x | y；optional: p | q',
    );
    expect(describeToolEnums(z.object({ plain: z.string() }))).toBe('');
  });

  it('tools/list 的 inputSchema 附带 enum 取值全集（schema 与描述同源）', () => {
    const schema = z.object({
      mode: z.enum(['alpha', 'beta']),
      note: z.string().optional(),
    });
    const json = zodObjectToJsonSchema(schema);
    expect(json.properties.mode).toEqual({
      type: 'string',
      enum: ['alpha', 'beta'],
    });
    expect(json.properties.note).toEqual({ type: 'string' });
  });

  it('真实工具集里 notify_agent 的 type/stage/kind 取值在描述中可见', () => {
    const notify = buildPlatformMcpTools(service).find(
      (t) => t.name === 'notify_agent',
    )!;
    expect(notify.description).toContain('type: answer | question | help');
    expect(notify.description).toContain('stage: process | end');
    expect(notify.description).toContain(
      'kind: execution | review | nudge | wake',
    );
  });
});
