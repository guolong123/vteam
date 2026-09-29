import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  layerBudgetTable,
  SECRET_COMMAND_DISPOSITION,
  SECRET_COMMAND_MAX_TIMEOUT_SEC,
  SECRET_COMMAND_SERVER_MAX_BUDGET_MS,
  SECRET_COMMAND_TIMEOUT_LAYER,
  SECRET_COMMAND_TOTAL_BUDGET_MS,
  secretCommandBudgetHeaderValue,
  secretCommandLayerTag,
} from './platform-mcp.constants';

/**
 * `docs/secret-command-tool.md` 的「三之二」层表是**手抄**的（markdown 不会被 TS 渲染），
 * 本 spec 把它钉到 `layerBudgetTable()` 上：预算常量改了而文档没改 ⇒ 这里红。
 *
 * 另含预算算术的自洽对账（`server_max` / `total` / 客户端下限）——这几条一旦漂移，
 * 「客户端超时须 ≥ 服务端最坏预算」的前提就不成立，而那条前提是超时可诊断的根。
 */
describe('platform-mcp secret_command 常量与文档层表一致性', () => {
  const DOC_PATH = path.resolve(
    __dirname,
    '../../../docs/secret-command-tool.md',
  );
  const doc = (): string => fs.readFileSync(DOC_PATH, 'utf8');

  /** 取「三之二」小节里那张 6 行层表（以 `| # | 层 |` 表头定位，避开别的表）。 */
  const docLayerRows = (): Map<string, string[]> => {
    const lines = doc().split('\n');
    const header = lines.findIndex((l) => /^\|\s*#\s*\|\s*层\s*\|/.test(l));
    expect(header).toBeGreaterThan(-1);
    const rows = new Map<string, string[]>();
    for (const line of lines.slice(header + 2)) {
      if (!line.startsWith('|')) break;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 5) break;
      const name = cells[1].replace(/`/g, '');
      rows.set(name, cells);
    }
    return rows;
  };

  it('doc 层表 6 行的层名与顺序 == layerBudgetTable()', () => {
    const rows = docLayerRows();
    expect([...rows.keys()]).toEqual(layerBudgetTable().map((s) => s.layer));
  });

  it('doc 层表每行「实际生效值」与 layerBudgetTable().effective 逐行一致（手抄漂移即红）', () => {
    const rows = docLayerRows();
    for (const spec of layerBudgetTable()) {
      const cells = rows.get(spec.layer);
      expect(cells).toBeDefined();
      // 文档单元格允许把 `code` 排版成行内代码，故比对时去掉反引号与加粗标记。
      const docCell = (cells as string[])[2]
        .replace(/`/g, '')
        .replace(/\*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const expected = spec.effective.replace(/\s+/g, ' ').trim();
      expect({ layer: spec.layer, docCell, expected }).toEqual({
        layer: spec.layer,
        docCell: expected,
        expected,
      });
    }
  });

  it('doc 层表每行「控制方」与 layerBudgetTable().owner 逐行一致', () => {
    const rows = docLayerRows();
    for (const spec of layerBudgetTable()) {
      const docCell = ((rows.get(spec.layer) as string[])[3] ?? '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      expect({ layer: spec.layer, docCell, owner: spec.owner }).toEqual({
        layer: spec.layer,
        docCell: spec.owner,
        owner: spec.owner,
      });
    }
  });

  it('「超时后服务端可能仍在执行」列：doc 的是/否 == serverMayStillRun，且只有 input_budget 为否', () => {
    const rows = docLayerRows();
    for (const spec of layerBudgetTable()) {
      const cell = ((rows.get(spec.layer) as string[])[4] ?? '')
        .replace(/\*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      // 文档在「否」那格加了长解释，只判首字（是/否），细节文字不参与比对。
      const truthy = cell.trim().startsWith('是');
      expect({
        layer: spec.layer,
        truthy,
        flag: spec.serverMayStillRun,
      }).toEqual({
        layer: spec.layer,
        truthy: spec.serverMayStillRun,
        flag: spec.serverMayStillRun,
      });
    }
    const stillRunnable = layerBudgetTable()
      .filter((s) => s.serverMayStillRun)
      .map((s) => s.layer);
    expect(stillRunnable).not.toContain(
      SECRET_COMMAND_TIMEOUT_LAYER.INPUT_BUDGET,
    );
  });

  it('C3：gateway 层的「须 ≥ Ns」由 SECRET_COMMAND_TOTAL_BUDGET_MS 渲染（无手写 855）', () => {
    const gateway = layerBudgetTable().find(
      (s) => s.layer === SECRET_COMMAND_TIMEOUT_LAYER.GATEWAY,
    );
    expect(gateway?.effective).toBe(
      `由部署侧决定（平台不可控），须 ≥ ${Math.round(
        SECRET_COMMAND_TOTAL_BUDGET_MS / 1000,
      )}s`,
    );
  });

  it('预算算术自洽：server_max = 输入+命令上限+请求裕量，total = server_max+传输裕量', () => {
    expect(SECRET_COMMAND_SERVER_MAX_BUDGET_MS).toBe(
      540_000 + SECRET_COMMAND_MAX_TIMEOUT_SEC * 1000 + 5_000,
    );
    expect(SECRET_COMMAND_TOTAL_BUDGET_MS).toBe(855_000);
    expect(SECRET_COMMAND_TOTAL_BUDGET_MS).toBeGreaterThan(
      SECRET_COMMAND_SERVER_MAX_BUDGET_MS,
    );
  });

  it('层标签序数由外到内且总数固定（错误 message 里的 layer=i/6 依赖它）', () => {
    expect(secretCommandLayerTag(SECRET_COMMAND_TIMEOUT_LAYER.GATEWAY)).toBe(
      'layer=1/6:gateway',
    );
    expect(
      secretCommandLayerTag(SECRET_COMMAND_TIMEOUT_LAYER.WORKER_REQUEST),
    ).toBe('layer=6/6:worker_request');
  });

  it('预算自述头是纯服务端常量（不含任何入参⇒不可被调用方影响）', () => {
    const header = secretCommandBudgetHeaderValue();
    expect(header).toBe(
      `total=${SECRET_COMMAND_TOTAL_BUDGET_MS};` +
        `server_max=${SECRET_COMMAND_SERVER_MAX_BUDGET_MS};` +
        `client_floor=900000;input_budget=540000;` +
        `command_default=60000;command_max=${
          SECRET_COMMAND_MAX_TIMEOUT_SEC * 1000
        };worker_slack=5000;keepalive=60000`,
    );
    expect(header).not.toMatch(/[A-Za-z0-9]{20,}/); // 无 token 形态长串
  });

  it('disposition 两值互斥且穷尽（问题 3 的「跑没跑」判定面）', () => {
    expect(Object.values(SECRET_COMMAND_DISPOSITION).sort()).toEqual([
      'executed',
      'not_executed',
    ]);
  });
});
