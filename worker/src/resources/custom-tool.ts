/**
 * 通用自定义工具渲染器（T4b；T19：产物形态从「v1 工具文件」改为「v1/v2 双形态插件模块」）。
 *
 * 产物落点：`<workDir>/.opencode/plugins/<file>.ts`。
 * - v2：`.opencode/plugins/` 是**唯一**的工具注册入口（`.opencode/tools/*.ts` 的文件自动
 *   发现在 v2 **已移除**——连 import 副作用都不发生）。
 * - v1：同样扫描 `.opencode/plugins/`（v1 的插件形态：default export 上的 `server()`），
 *   ⇒ **同一份产物**在两代 serve 下都能被加载（v1 回退路径成立）。
 *
 * 形态（T5 spike 实测）：
 * - v2：`Plugin.define({ id, setup(ctx) { ctx.tool.transform(editor => editor.add({...})) } })`
 *   - 入参是 **JSON Schema**（v1 是 Zod）；
 *   - 返回值是 **`{ content }`**（v1 是裸字符串）；
 *   - **必须**写 `options: { codemode: false }`——否则插件工具默认只出现在 system 的
 *     Code Mode 目录里，模型必须写 JS 经 `execute` 调用，**无法直接 `tool_calls`**
 *     （v1 的工具是直接暴露给模型的，语义等价于 `codemode: false`）。
 * - v1：`async server()` 返回 `{ tool: { <name>: tool({...}) } }`（Zod 入参、字符串返回）。
 *
 * ⚠️ **v1 也会调用 `setup`**（v1 的 plugin ctx 里没有 `ctx.tool`）→ v2 分支必须防呆：
 * `if (!ctx?.tool?.transform) return`，否则 v1 会在 setup 里炸。
 *
 * ⚠️ **`@opencode/plugin` 必须动态 import**：v1（1.18.x）二进制里**没有**这个包
 * （实测：`strings` 在 v1 二进制里命中 0 次；静态 import 会让整个模块在 v1 下**加载失败**
 * ——v1 静默跳过该插件 → v1 回退路径上的工具全部消失）。v2 宿主**内置**该模块
 * （静态/动态 import 都能解析，**不需要** work dir 里有 node_modules）。
 *
 * 工具命名（11 篇 §3.2，v1/v2 一致）：
 * - 具名导出（export const <name>）→ 工具名 = <文件名>_<导出名>（如 git.ts 导出 clone → git_clone）
 * - 默认导出（export default）→ 工具名 = 文件名（注入 DB 工具时用，保证工具名 = action，FR-48）
 *
 * execute 按 execution 分支渲染（MUST DO T4b）：
 * - cli  → spawnSync(command[0], [command.slice(1), ...cmdArgs])（boolean→--flag，其余→positional）
 * - http → fetch 转发（method/url/headers + args JSON body，非 2xx 抛错）
 * - code → 内联 JS（原样嵌入 execute 体）
 *
 * 本模块不依赖 server 代码（worker 独立进程铁律）。
 */

/** 参数类型（映射 JSON Schema 的 string/boolean/number 与 v1 的 tool.schema）。 */
export type CustomToolArgType = 'string' | 'boolean' | 'integer';

export interface CustomToolArg {
  /** 参数名（v1 tool.schema 的键 = v2 JSON Schema properties 的键）。 */
  name: string;
  type: CustomToolArgType;
  /** 是否必填（v1：必填不带 .optional()；v2：进 required 数组）。 */
  required: boolean;
  /** 参数描述。 */
  description: string;
}

/** 执行定义：三种 execution 形态的 execute 渲染源。 */
export type CustomToolExecution =
  | { type: 'cli'; command: string[] }
  | {
      type: 'http';
      url: string;
      method: string;
      headers?: Record<string, string>;
    }
  | { type: 'code'; code: string };

export interface CustomToolExport {
  /** 导出名；'default' 渲染为默认导出（工具名 = 文件名）。 */
  exportName: string;
  description: string;
  args: CustomToolArg[];
  execute: CustomToolExecution;
}

export interface CustomToolFileDef {
  /** 目标文件名（不含 .ts 后缀），决定默认导出工具名。 */
  fileName: string;
  exports: CustomToolExport[];
}

/**
 * 工具名规则（11 篇 §3.2，v1/v2 一致）：
 * - 默认导出 → 工具名 = 文件名（注入 DB 工具时 = action，FR-48）；
 * - 具名导出 → 工具名 = <文件名>_<导出名>（git.ts 导出 clone → git_clone）。
 */
export function resolveToolName(fileName: string, exportName: string): string {
  return exportName === 'default' ? fileName : `${fileName}_${exportName}`;
}

/** 参数类型 → JSON Schema type（integer 映射为 number，与 v1 的 tool.schema.number() 对齐）。 */
function jsonSchemaType(type: CustomToolArgType): 'string' | 'boolean' | 'number' {
  return type === 'integer' ? 'number' : type;
}

/** 渲染单个参数 schema（v1 分支的 Zod 形态）。 */
function renderArgSchema(arg: CustomToolArg): string {
  const schemaType = arg.type === 'integer' ? 'number' : arg.type;
  const base = `tool.schema.${schemaType}()`;
  const schema = arg.required ? base : `${base}.optional()`;
  return `${schema}.describe(${JSON.stringify(arg.description)})`;
}

/**
 * 渲染 cli execute 体：spawnSync(command[0], [command.slice(1), ...cmdArgs])。
 * file 参数必须是字符串（F3：数组作 file 运行时抛 ERR_INVALID_ARG_TYPE）。
 *
 * @returns 函数体行（不含外层 `async execute(args) {` 包装——共享实现函数自己包）。
 */
function renderCliExecute(command: string[]): string[] {
  const fileLiteral = JSON.stringify(command[0] ?? '');
  const restLiteral = command.slice(1).map((s) => JSON.stringify(s)).join(', ');
  const spawnArgs = restLiteral ? `[${restLiteral}, ...cmdArgs]` : 'cmdArgs';
  const cmdLabel = command.join(' ');
  return [
    'const cmdArgs: string[] = [];',
    'for (const [key, value] of Object.entries(args)) {',
    '  if (value === undefined || value === null || value === false) continue;',
    '  if (typeof value === "boolean") { cmdArgs.push(`--${key}`); continue; }',
    '  cmdArgs.push(String(value));',
    '}',
    `const result = spawnSync(${fileLiteral}, ${spawnArgs}, { encoding: "utf8" });`,
    'if (result.status !== 0) {',
    '  const err = (result.stderr || result.stdout || "").trim();',
    `  throw new Error(\`${cmdLabel} failed (exit \${result.status}): \${err}\`);`,
    '}',
    'return result.stdout ?? "";',
  ];
}

/**
 * 渲染 http execute 体：fetch 转发（args 序列化为 JSON body）。
 *
 * @returns 函数体行（不含外层包装）。
 */
function renderHttpExecute(
  url: string,
  method: string,
  headers?: Record<string, string>,
): string[] {
  const headersLiteral = headers ? JSON.stringify(headers) : 'undefined';
  return [
    'const hasArgs = args && Object.keys(args).length > 0;',
    `const response = await fetch(${JSON.stringify(url)}, {`,
    `  method: ${JSON.stringify(method)},`,
    `  headers: ${headersLiteral},`,
    '  body: hasArgs ? JSON.stringify(args) : undefined,',
    '});',
    'if (!response.ok) {',
    `  throw new Error(\`HTTP ${method} ${url} failed: \${response.status} \${response.statusText}\`);`,
    '}',
    'return await response.text();',
  ];
}

/** 渲染 code 分支的 execute 体（原样内联）。 */
function renderCodeExecute(code: string): string[] {
  return code.split('\n');
}

/**
 * 双形态插件模块里的**单个工具**描述（渲染用）。
 *
 * 两侧共用同一个共享实现函数（`execFn`），差异只在调用表达式与入参 schema：
 * - v2：`input` 是 JSON Schema，返回值包成 `{ content }`；
 * - v1：`args` 是 Zod，返回值是裸字符串。
 */
export interface PluginToolSpec {
  /** 工具名（v1/v2 完全一致 = 权限 action）。 */
  name: string;
  /** 工具描述（v1/v2 完全一致）。 */
  description: string;
  /** 入参定义（v1 → Zod；v2 → JSON Schema）。 */
  args: CustomToolArg[];
  /** 共享实现函数的模块级函数名。 */
  execFn: string;
  /** v2 分支调用共享实现的表达式（可见 `input` / `toolContext` / `ctx`）。 */
  v2Call: string;
  /** v1 分支调用共享实现的表达式（可见 `args` / `toolContext`）。 */
  v1Call: string;
  /** v2 分支的 execute 是否需要 `toolContext` 形参。 */
  v2NeedsToolContext?: boolean;
  /** v1 分支的 execute 是否需要 `toolContext` 形参。 */
  v1NeedsToolContext?: boolean;
}

/** 双形态插件模块的整体描述（渲染用）。 */
export interface PluginModuleSpec {
  /** v2 插件 id（`Plugin.define` 的 id；稳定且全局唯一）。 */
  id: string;
  /** 文件头注释行（不含 `/**` 与 `* /`）。 */
  header: string[];
  /** 额外 import 行（`@opencode/plugin` 由动态 import 引入，不在此列）。 */
  imports?: string[];
  /** 共享实现之前的模块级代码（辅助函数等）。 */
  preamble?: string[];
  /** 工具清单。 */
  tools: PluginToolSpec[];
}

/** JSON Schema 的 properties 片段（每个参数一行）。 */
function renderJsonSchemaProperties(args: CustomToolArg[]): string[] {
  return args.map(
    (arg) =>
      `${JSON.stringify(arg.name)}: { type: ${JSON.stringify(jsonSchemaType(arg.type))}, description: ${JSON.stringify(arg.description)} },`,
  );
}

/** v1 分支的 Zod 入参（每行一个）。 */
function renderV1ZodArgs(args: CustomToolArg[]): string[] {
  return args.map((arg) => `${arg.name}: ${renderArgSchema(arg)},`);
}

/**
 * 渲染 **v1/v2 双形态插件模块**（`.opencode/plugins/<file>.ts`）。
 *
 * 结构：
 * 1. 文件头注释 + 额外 import；
 * 2. `const { Plugin } = await import("@opencode/plugin").catch(...)`（动态 import + v1 兜底）；
 * 3. 每个工具一个共享实现函数（v1/v2 共用）；
 * 4. `export default { ...Plugin.define({ id, setup }), async server() { ... } }`。
 */
export function renderPluginModule(spec: PluginModuleSpec): string {
  const lines: string[] = [];

  lines.push('/**');
  for (const line of spec.header) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  for (const imp of spec.imports ?? []) {
    lines.push(imp);
  }
  if ((spec.imports ?? []).length > 0) {
    lines.push('');
  }

  lines.push(
    '/**',
    ' * v2 插件 API（`@opencode/plugin`）。',
    ' *',
    ' * ⚠️ **必须动态 import**：v1（1.18.x）二进制里没有这个包（静态 import 会让整个模块在',
    ' * v1 下加载失败——v1 静默跳过该插件 → v1 回退路径上的工具全部消失）；v2 宿主内置该模块',
    ' * （动态 import 可解析，**不需要** work dir 里有 node_modules）。',
    ' * 兜底分支里的 `define` 是 identity（@opencode/plugin 里 `Plugin.define` 本身就是 identity',
    ' * function）→ 展开后等价于 `{ id, setup, server }`，v1 走 `server()` 分支。',
    ' */',
    'const { Plugin } = (await import("@opencode/plugin").catch(() => ({',
    '  Plugin: { define: (plugin: unknown) => plugin },',
    '}))) as unknown as typeof import("@opencode/plugin")',
    '',
  );

  for (const block of spec.preamble ?? []) {
    lines.push(block);
    lines.push('');
  }

  lines.push('export default {');
  lines.push('  ...Plugin.define({');
  lines.push(`    id: ${JSON.stringify(spec.id)},`);
  lines.push('    async setup(ctx: any) {');
  lines.push(
    '      // ⚠️ v1 也会调用 setup（v1 的 plugin ctx 里没有 ctx.tool）→ 必须防呆，否则 v1 会炸',
    '      if (!ctx?.tool?.transform) return',
    '      await ctx.tool.transform((editor: any) => {',
  );
  for (const tool of spec.tools) {
    lines.push('        editor.add({');
    lines.push(`          name: ${JSON.stringify(tool.name)},`);
    lines.push(`          description: ${JSON.stringify(tool.description)},`);
    lines.push('          input: {');
    lines.push('            type: "object",');
    lines.push('            properties: {');
    for (const line of renderJsonSchemaProperties(tool.args)) {
      lines.push(`              ${line}`);
    }
    lines.push('            },');
    const required = tool.args.filter((a) => a.required).map((a) => JSON.stringify(a.name));
    lines.push(`            required: [${required.join(', ')}],`);
    lines.push('            additionalProperties: false,');
    lines.push('          },');
    lines.push(
      '          // ⚠️ 必写：不写的话插件工具默认只进 Code Mode 目录，模型无法直接 tool_calls',
      '          options: { codemode: false },',
    );
    const v2Params = tool.v2NeedsToolContext ? 'input: any, toolContext: any' : 'input: any';
    lines.push(`          execute: async (${v2Params}) => ({`);
    lines.push(`            content: await ${tool.v2Call},`);
    lines.push('          }),');
    lines.push('        })');
  }
  lines.push('      })');
  lines.push('      return () => {');
  lines.push('        // 工具随插件生命周期注册，无需显式清理');
  lines.push('      }');
  lines.push('    },');
  lines.push('  }),');
  lines.push('  async server() {');
  lines.push(
    '    // v1 分支：v1 的插件形态返回 { tool: { <name>: tool({...}) } }（Zod 入参、字符串返回）',
  );
  lines.push('    // ⚠️ 包名用变量传给 import()：`@opencode-ai/plugin` 只存在于 v1 二进制里，');
  lines.push('    // 用字面量会让 v2 侧的 `tsc --noEmit` 报 TS2307（模块不存在）；变量形式运行时照样解析。');
  lines.push('    const __vteamV1PluginPackage = "@opencode-ai/plugin"');
  lines.push('    const { tool } = (await import(__vteamV1PluginPackage)) as any');
  lines.push('    return {');
  lines.push('      tool: {');
  for (const tool of spec.tools) {
    lines.push(`        ${JSON.stringify(tool.name)}: tool({`);
    lines.push(`          description: ${JSON.stringify(tool.description)},`);
    lines.push('          args: {');
    for (const line of renderV1ZodArgs(tool.args)) {
      lines.push(`            ${line}`);
    }
    lines.push('          },');
    const v1Params = tool.v1NeedsToolContext ? 'args: any, toolContext: any' : 'args: any';
    lines.push(`          async execute(${v1Params}) {`);
    lines.push(`            return await ${tool.v1Call};`);
    lines.push('          },');
    lines.push('        }),');
  }
  lines.push('      },');
  lines.push('    };');
  lines.push('  },');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

/**
 * 渲染平台自定义工具的 **v1/v2 双形态插件模块**（`.opencode/plugins/<file>.ts`）。
 *
 * 每个导出（工具）对应一个共享实现函数；v1/v2 两侧调用同一个函数，
 * 保证**工具名、描述、入参名与语义在两代完全一致**。
 */
export function renderCustomToolPlugin(def: CustomToolFileDef): string {
  const imports: string[] = [];
  if (def.exports.some((e) => e.execute.type === 'cli')) {
    imports.push('import { spawnSync } from "node:child_process";');
  }

  const tools: PluginToolSpec[] = [];
  const preamble: string[] = [];

  def.exports.forEach((exp, index) => {
    const toolName = resolveToolName(def.fileName, exp.exportName);
    const execFn = `__vteam_exec_${index + 1}`;
    let body: string[];
    switch (exp.execute.type) {
      case 'cli':
        body = renderCliExecute(exp.execute.command);
        break;
      case 'http':
        body = renderHttpExecute(
          exp.execute.url,
          exp.execute.method,
          exp.execute.headers,
        );
        break;
      case 'code':
        body = renderCodeExecute(exp.execute.code);
        break;
    }
    preamble.push(
      [
        `/** ${toolName} 的共享实现（v1/v2 共用）。 */`,
        `async function ${execFn}(args: any): Promise<string> {`,
        ...body.map((line) => `  ${line}`),
        '}',
      ].join('\n'),
    );
    tools.push({
      name: toolName,
      description: exp.description,
      args: exp.args,
      execFn,
      v2Call: `${execFn}(input)`,
      v1Call: `${execFn}(args)`,
    });
  });

  return renderPluginModule({
    id: `vteam-tool-${def.fileName}`,
    header: [
      '平台自定义工具（T4b 自动注入）——由 worker 从控制面 tools 资源拉取后渲染。',
      '产物形态（T19）：**v1/v2 双形态插件模块**（`.opencode/plugins/`）。',
      '工具名规则（11 篇 §3.2）：默认导出 = 文件名；具名导出 = <文件名>_<导出名>。',
      '工具名即权限 action（FR-48）。v1/v2 两侧工具名、描述、入参完全一致。',
    ],
    imports,
    preamble,
    tools,
  });
}
