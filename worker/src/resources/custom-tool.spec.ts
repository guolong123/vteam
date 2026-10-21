import * as vm from 'node:vm';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import * as ts from 'typescript';
import {
  CustomToolFileDef,
  renderCustomToolPlugin,
  resolveToolName,
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

/** v1 形态的工具定义（`server()` 返回的 `{ tool: { name: def } }`）。 */
interface V1ToolDef {
  description: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** v2 形态的工具注册（`editor.add({...})` 的入参）。 */
interface V2ToolDef {
  name: string;
  description: string;
  input: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
  options?: { codemode?: boolean };
  execute: (input: Record<string, unknown>, context: unknown) => Promise<{ content: string }>;
}

/**
 * 把渲染出的**插件模块**在 vm 沙箱中真实执行：
 * - 顶层 await 的插件 API 加载 → 换成 identity 兜底（v1 分支的语义）；
 * - v1 分支的 `@opencode-ai/plugin` 动态 import → 换成 `tool()` stub；
 * - 然后分别取 v1 形态（`server()`）与 v2 形态（`setup(ctx)`）的工具定义。
 */
async function evalRenderedPlugin(content: string): Promise<{
  v1Tools: Record<string, V1ToolDef>;
  v2Tools: V2ToolDef[];
}> {
  // vm 沙箱是原生 JS → 先把两处动态 import 换成 stub，再用 typescript 转译（去掉类型注解）
  const stubbed = content
    .replace(
      'const { Plugin } = (await import("@opencode/plugin").catch(() => ({\n' +
        '  Plugin: { define: (plugin: unknown) => plugin },\n' +
        '}))) as unknown as typeof import("@opencode/plugin")',
      'const Plugin = { define: (plugin: any) => plugin }',
    )
    .replace(
      'const __vteamV1PluginPackage = "@opencode-ai/plugin"\n' +
        '    const { tool } = (await import(__vteamV1PluginPackage)) as any',
      'const { tool } = __toolStub',
    )
    .split('\n')
    .filter((line) => !line.trim().startsWith('import '))
    .join('\n');

  const transpiled = ts.transpileModule(stubbed, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const executable = transpiled.replace('export default {', 'const __plugin = {');

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
    __toolStub: { tool: toolStub },
  };
  vm.createContext(sandbox);
  const runner = `(async () => { ${executable}\n globalThis.__plugin = __plugin; })()`;
  await vm.runInContext(runner, sandbox);

  const plugin = sandbox.__plugin as {
    id: string;
    setup: (ctx: unknown) => Promise<unknown>;
    server: () => Promise<{ tool: Record<string, V1ToolDef> }>;
  };

  const v2Tools: V2ToolDef[] = [];
  await plugin.setup({
    tool: {
      transform: async (fn: (editor: { add: (t: V2ToolDef) => void }) => void) => {
        fn({ add: (t: V2ToolDef) => v2Tools.push(t) });
      },
    },
  });

  const v1 = await plugin.server();
  return { v1Tools: v1.tool, v2Tools };
}

describe('renderCustomToolPlugin', () => {
  it('产物形态：v1/v2 双形态插件模块（Plugin.define + setup + server）', () => {
    const content = renderCustomToolPlugin(cliDef());
    expect(content).toContain('Plugin.define');
    expect(content).toContain('id: "vteam-tool-jira-query"');
    expect(content).toContain('async setup(ctx: any)');
    expect(content).toContain('ctx.tool.transform');
    expect(content).toContain('editor.add({');
    expect(content).toContain('async server()');
    // v1 形态：Zod 入参 + 裸字符串返回；v2 形态：JSON Schema 入参 + { content } 返回
    expect(content).toContain('tool.schema.string().describe("任务名")');
    expect(content).toContain('type: "object"');
    expect(content).toContain('content: await');
    // T15 陷阱：agent 段的 `prompt` 键会被 v2 静默丢弃——生成物里不允许出现
    expect(content).not.toMatch(/\bprompt\s*:/);
  });

  it('每个工具注册都带 options: { codemode: false }（否则模型只能经 Code Mode 调）', () => {
    const content = renderCustomToolPlugin(cliDef());
    const registrations = content.split('editor.add({').length - 1;
    expect(registrations).toBe(1);
    expect(content).toContain('options: { codemode: false },');
  });

  it('v2 分支带 setup 防呆护栏（v1 也会调用 setup，其 ctx 没有 ctx.tool）', () => {
    const content = renderCustomToolPlugin(cliDef());
    expect(content).toContain('if (!ctx?.tool?.transform) return');
  });

  it('插件 API 用动态 import（v1 二进制没有 @opencode/plugin，静态 import 会让模块加载失败）', () => {
    const content = renderCustomToolPlugin(cliDef());
    expect(content).toContain('await import("@opencode/plugin")');
    expect(content).not.toMatch(/^import \{ Plugin \} from "@opencode\/plugin"/m);
  });

  it('工具名规则：默认导出 = 文件名；具名导出 = <文件名>_<导出名>', () => {
    expect(resolveToolName('jira-query', 'default')).toBe('jira-query');
    expect(resolveToolName('git', 'clone')).toBe('git_clone');

    const def: CustomToolFileDef = {
      fileName: 'math',
      exports: [
        { exportName: 'add', description: '加法', args: [], execute: { type: 'code', code: 'return String(1 + 1);' } },
        { exportName: 'mul', description: '乘法', args: [], execute: { type: 'code', code: 'return String(2 * 2);' } },
      ],
    };
    const content = renderCustomToolPlugin(def);
    expect(content).toContain('name: "math_add"');
    expect(content).toContain('name: "math_mul"');
  });

  it('cli 分支：注入 spawnSync + command 拆分（file 字符串 + 参数数组）+ args 序列化（boolean→--flag）', () => {
    const content = renderCustomToolPlugin(cliDef());
    expect(content).toContain('import { spawnSync } from "node:child_process";');
    expect(content).toContain('spawnSync("jcli", ["issue", "get", ...cmdArgs], { encoding: "utf8" })');
    expect(content).not.toContain('spawnSync(["jcli"');
    expect(content).toContain('if (typeof value === "boolean") { cmdArgs.push(`--${key}`); continue; }');
    expect(content).toContain('cmdArgs.push(String(value));');
    expect(content).toContain('result.status !== 0');
  });

  it('cli 分支运行时语义：v1/v2 两侧渲染代码真实执行成功（echo 工具，boolean→--flag + positional）', async () => {
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
    const { v1Tools, v2Tools } = await evalRenderedPlugin(renderCustomToolPlugin(def));
    const v1Output = await v1Tools['echo-hello'].execute({ suffix: 'world', loud: true });
    // echo hello world --loud：命令前缀 + positional 后缀 + boolean→--flag 均真实生效
    expect(v1Output).toContain('hello');
    expect(v1Output).toContain('world');
    expect(v1Output).toContain('--loud');

    // v2 侧：返回值是 { content }，入参是 JSON Schema
    expect(v2Tools).toHaveLength(1);
    expect(v2Tools[0].name).toBe('echo-hello');
    expect(v2Tools[0].input.type).toBe('object');
    expect(v2Tools[0].input.properties.suffix.type).toBe('string');
    expect(v2Tools[0].input.required).toEqual([]);
    const v2Result = await v2Tools[0].execute({ suffix: 'world', loud: true }, {});
    expect(v2Result.content).toContain('hello');
    expect(v2Result.content).toContain('--loud');
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
    const { v1Tools } = await evalRenderedPlugin(renderCustomToolPlugin(def));
    await expect(v1Tools['fail-tool'].execute({})).rejects.toThrow(/failed \(exit 3\)/);
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
    const content = renderCustomToolPlugin(def);
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
    const content = renderCustomToolPlugin(def);
    expect(content).toContain('async function __vteam_exec_1(args: any): Promise<string> {');
    expect(content).toContain('return String(Number(args.a) + Number(args.b));');
  });

  it('参数 schema：v1 用 Zod（required 不带 optional），v2 用 JSON Schema（required 进数组）', () => {
    const content = renderCustomToolPlugin(cliDef());
    expect(content).toContain('jobName: tool.schema.string().describe("任务名")');
    expect(content).toContain('limit: tool.schema.number().optional().describe("条数上限")');
    expect(content).toContain('verbose: tool.schema.boolean().optional().describe("详细输出")');
    expect(content).toContain('"jobName": { type: "string", description: "任务名" },');
    expect(content).toContain('"limit": { type: "number", description: "条数上限" },');
    expect(content).toContain('"verbose": { type: "boolean", description: "详细输出" },');
    expect(content).toContain('required: ["jobName"],');
    expect(content).toContain('additionalProperties: false,');
  });

  it('纯 code 工具不引入 spawnSync import', () => {
    const def: CustomToolFileDef = {
      fileName: 'x',
      exports: [
        { exportName: 'default', description: 'd', args: [], execute: { type: 'code', code: 'return "ok";' } },
      ],
    };
    const content = renderCustomToolPlugin(def);
    expect(content).not.toContain('child_process');
  });
});
