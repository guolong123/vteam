import * as vm from 'node:vm';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  CustomToolFileDef,
  renderCustomToolFile,
} from './custom-tool';

function cliDef(): CustomToolFileDef {
  return {
    fileName: 'jira-query',
    exports: [
      {
        exportName: 'default',
        description: '按关键词查询 Jira 工单',
        args: [
          { name: 'jobName', type: 'string', required: true, description: '任务名' },
          { name: 'limit', type: 'integer', required: false, description: '条数上限' },
          { name: 'verbose', type: 'boolean', required: false, description: '详细输出' },
        ],
        execute: { type: 'cli', command: ['jcli', 'issue', 'get'] },
      },
    ],
  };
}

/** 把渲染出的工具文件在 vm 沙箱中真实执行（stub tool()，提供真实 spawnSync），返回工具定义。 */
function evalRenderedTool(content: string): { execute: (args: Record<string, unknown>) => Promise<string> } {
  const executable = content
    .split('\n')
    .filter((line) => !line.trim().startsWith('import '))
    .join('\n')
    .replace('export default tool({', 'const __toolDef = tool({')
    // vm 沙箱是原生 JS，不转译 TS 类型注解（渲染代码仅 cli execute 有一处 cmdArgs 注解）
    .replace('const cmdArgs: string[] = [];', 'const cmdArgs = [];')
    .concat('\nglobalThis.__toolDef = __toolDef;');
  const schemaVal = () => ({
    optional: () => ({ describe: () => ({}) }),
    describe: () => ({}),
  });
  const toolStub = ((def: unknown) => def) as {
    (def: unknown): unknown;
    schema: Record<string, () => unknown>;
  };
  toolStub.schema = { string: schemaVal, number: schemaVal, boolean: schemaVal };
  const sandbox: Record<string, unknown> = {
    spawnSync: nodeSpawnSync,
    tool: toolStub,
  };
  vm.createContext(sandbox);
  vm.runInContext(executable, sandbox);
  return sandbox.__toolDef as { execute: (args: Record<string, unknown>) => Promise<string> };
}

describe('renderCustomToolFile', () => {
  it('默认导出：export default + 工具名 = 文件名（注入 DB 工具形态）', () => {
    const content = renderCustomToolFile(cliDef());
    expect(content).toContain('export default tool({');
    expect(content).not.toContain('export const');
  });

  it('具名导出：export const <name>（git 族多工具形态）', () => {
    const def: CustomToolFileDef = {
      fileName: 'math',
      exports: [
        { exportName: 'add', description: '加法', args: [], execute: { type: 'code', code: 'return String(1 + 1);' } },
        { exportName: 'mul', description: '乘法', args: [], execute: { type: 'code', code: 'return String(2 * 2);' } },
      ],
    };
    const content = renderCustomToolFile(def);
    expect(content).toContain('export const add = tool({');
    expect(content).toContain('export const mul = tool({');
  });

  it('cli 分支：注入 spawnSync + command 拆分（file 字符串 + 参数数组）+ args 序列化（boolean→--flag）', () => {
    const content = renderCustomToolFile(cliDef());
    expect(content).toContain('import { spawnSync } from "node:child_process";');
    expect(content).toContain('spawnSync("jcli", ["issue", "get", ...cmdArgs], { encoding: "utf8" })');
    expect(content).not.toContain('spawnSync(["jcli"');
    expect(content).toContain('if (typeof value === "boolean") { cmdArgs.push(`--${key}`); continue; }');
    expect(content).toContain('cmdArgs.push(String(value));');
    expect(content).toContain('result.status !== 0');
  });

  it('cli 分支运行时语义：渲染代码真实执行成功（echo 工具，boolean→--flag + positional）', async () => {
    const def: CustomToolFileDef = {
      fileName: 'echo-hello',
      exports: [
        {
          exportName: 'default',
          description: 'echo 测试',
          args: [
            { name: 'suffix', type: 'string', required: false, description: '后缀' },
            { name: 'loud', type: 'boolean', required: false, description: '大写' },
          ],
          execute: { type: 'cli', command: ['echo', 'hello'] },
        },
      ],
    };
    const toolDef = evalRenderedTool(renderCustomToolFile(def));
    const output = await toolDef.execute({ suffix: 'world', loud: true });
    // echo hello world --loud：命令前缀 + positional 后缀 + boolean→--flag 均真实生效
    expect(output).toContain('hello');
    expect(output).toContain('world');
    expect(output).toContain('--loud');
  });

  it('cli 分支运行时语义：非 0 退出抛错（真实 spawnSync 执行）', async () => {
    const def: CustomToolFileDef = {
      fileName: 'fail-tool',
      exports: [
        {
          exportName: 'default',
          description: '失败工具',
          args: [],
          execute: { type: 'cli', command: ['node', '-e', 'process.exit(3)'] },
        },
      ],
    };
    const toolDef = evalRenderedTool(renderCustomToolFile(def));
    await expect(toolDef.execute({})).rejects.toThrow(/failed \(exit 3\)/);
  });

  it('http 分支：注入 fetch + method/url/headers + args JSON body', () => {
    const def: CustomToolFileDef = {
      fileName: 'jira-hook',
      exports: [
        {
          exportName: 'default',
          description: 'Jira HTTP 回调',
          args: [{ name: 'jobName', type: 'string', required: true, description: '任务名' }],
          execute: {
            type: 'http',
            url: 'https://hooks.example.com/tools/jira',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
        },
      ],
    };
    const content = renderCustomToolFile(def);
    expect(content).toContain('await fetch("https://hooks.example.com/tools/jira", {');
    expect(content).toContain('method: "POST"');
    expect(content).toContain('headers: {"Content-Type":"application/json"},');
    expect(content).toContain('body: hasArgs ? JSON.stringify(args) : undefined');
    expect(content).toContain('response.ok');
  });

  it('code 分支：execute 体原样内联', () => {
    const def: CustomToolFileDef = {
      fileName: 'inline-calc',
      exports: [
        {
          exportName: 'default',
          description: '内联计算',
          args: [],
          execute: { type: 'code', code: 'return String(Number(args.a) + Number(args.b));' },
        },
      ],
    };
    const content = renderCustomToolFile(def);
    expect(content).toContain('async execute(args) {');
    expect(content).toContain('return String(Number(args.a) + Number(args.b));');
  });

  it('参数 schema：required 不带 optional、描述用 describe 序列化', () => {
    const content = renderCustomToolFile(cliDef());
    expect(content).toContain('jobName: tool.schema.string().describe("任务名")');
    expect(content).toContain('limit: tool.schema.number().optional().describe("条数上限")');
    expect(content).toContain('verbose: tool.schema.boolean().optional().describe("详细输出")');
  });

  it('纯 code 工具不引入 spawnSync import', () => {
    const def: CustomToolFileDef = {
      fileName: 'x',
      exports: [
        { exportName: 'default', description: 'd', args: [], execute: { type: 'code', code: 'return "ok";' } },
      ],
    };
    const content = renderCustomToolFile(def);
    expect(content).toContain('import { tool } from "@opencode-ai/plugin";');
    expect(content).not.toContain('child_process');
  });
});
