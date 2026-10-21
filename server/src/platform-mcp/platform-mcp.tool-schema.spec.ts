import { BadRequestException } from '@nestjs/common';
import { ISSUE_TRANSITIONS } from '../issues/issues.constants';
import { TASK_TRANSITIONS } from '../common/constants/task.constants';
import {
  buildPlatformMcpTools,
  introspectPlatformTools,
  TOOL_SCHEMA_MAX_BYTES,
} from './platform-mcp.tools';
import { PlatformMcpService } from './platform-mcp.service';

/**
 * `vteam_tool_schema`（Fix 2）：schema 自描述通道的契约断言。
 *
 * 背景（生产 post-mortem）：Code Mode 的目录只显示 `vteam (34 tools, none shown)`，
 * agent 看不到参数签名，只能从校验报错反推枚举/必填。本工具把「注册项同源」的
 * schema 摊平成 agent 可读输出 ⇒ 下面每条断言都钉住「同源」而非手抄清单：
 * - 清单必须覆盖**全部**注册工具（漏一个就等于该工具又回到靠猜）；
 * - 单工具必须给出 required / 枚举全集 / 长度与数值约束；
 * - 状态机工具必须给出 `action: from[] → to` 全表（与迁移表常量逐项一致）；
 * - 输出有界（≤8KB），未知工具名是 400 + 候选而非 500/崩溃。
 */
describe('vteam_tool_schema introspection', () => {
  const service = {} as PlatformMcpService;
  const tools = buildPlatformMcpTools(service);
  const asResult = (name?: string): Record<string, unknown> =>
    introspectPlatformTools(tools, name);

  it('无参 ⇒ 一行一个覆盖全部注册工具，且输出 ≤8KB', () => {
    const result = asResult();
    const lines = result.tools as string[];
    expect(result.count).toBe(tools.length);
    expect(lines).toHaveLength(tools.length);
    // 每个注册工具名都出现（含自省工具本身）。
    for (const tool of tools) {
      expect(lines.some((line) => line.startsWith(`${tool.name} `))).toBe(true);
    }
    expect(lines.some((line) => line.startsWith('issue_transition '))).toBe(
      true,
    );
    expect(
      Buffer.byteLength(JSON.stringify(result), 'utf8'),
    ).toBeLessThanOrEqual(TOOL_SCHEMA_MAX_BYTES);
    expect(result.truncated).toBeUndefined();
  });

  it('每个清单行含 required：issue_transition 的 selfInstanceId 是必填', () => {
    const lines = asResult().tools as string[];
    const line = lines.find((l) => l.startsWith('issue_transition ')) as string;
    expect(line).toContain('issue_transition — ');
    expect(line).toContain('(required: taskId,selfInstanceId,issueId,action)');
  });

  it('name=issue_transition ⇒ required / 枚举全集 / 状态机全表（与 ISSUE_TRANSITIONS 同源）', () => {
    const result = asResult('issue_transition');
    expect(result.name).toBe('issue_transition');
    expect(result.required).toEqual([
      'taskId',
      'selfInstanceId',
      'issueId',
      'action',
    ]);
    expect(result.enums).toMatchObject({
      action: ['start', 'resolve', 'close', 'reopen', 'reject'],
    });
    expect(result.stateMachine).toEqual([
      'start: [open] → in_progress',
      'resolve: [in_progress] → resolved',
      'close: [resolved] → closed',
      'reopen: [closed, rejected] → open',
      'reject: [in_progress] → rejected',
    ]);
    // 防「手抄表」：逐项与常量对齐。
    expect((result.stateMachine as string[]).length).toBe(
      Object.keys(ISSUE_TRANSITIONS).length,
    );
  });

  it('name=task_transition ⇒ 状态机表来自 TASK_TRANSITIONS（含 mark-pending-review）', () => {
    const result = asResult('task_transition');
    const table = result.stateMachine as string[];
    expect(table).toEqual(
      Object.entries(TASK_TRANSITIONS).map(
        ([action, spec]) => `${action}: [${spec.from}] → ${spec.to}`,
      ),
    );
    expect(table).toContain(
      'mark-pending-review: [in_progress] → pending_review',
    );
  });

  it('非状态机工具 ⇒ 无 stateMachine 段；长度/数值约束原样透出', () => {
    const result = asResult('chat_history');
    expect(result.stateMachine).toBeUndefined();
    expect(result.constraints).toMatchObject({ limit: { maximum: 100 } });
    expect((result.required as string[]).length).toBe(0);
    expect(
      Buffer.byteLength(JSON.stringify(result), 'utf8'),
    ).toBeLessThanOrEqual(TOOL_SCHEMA_MAX_BYTES);
  });

  it('未知工具名 ⇒ 400 稳定码 + 最接近候选（不崩溃）', () => {
    let thrown: unknown;
    try {
      asResult('issue_transitionn');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const response = (thrown as BadRequestException).getResponse() as {
      code: string;
      message: string;
    };
    expect(response.code).toBe('PLATFORM_MCP_TOOL_UNKNOWN');
    expect(response.message).toContain('未知平台工具：issue_transitionn');
    expect(response.message).toContain('issue_transition');
    expect(response.message).toContain('省略 name');
  });
});
