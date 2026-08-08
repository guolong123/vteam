/**
 * 通用自定义工具文件渲染器（T4b）。
 *
 * 把平台 tools 表定义（code/cli/http 三种 execution）转写为 opencode 自定义工具
 * `.opencode/tools/<file>.ts`（11 篇 §3.2 路径①：目录扫描自动注册）。
 *
 * 工具命名（11 篇 §3.2）：
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

/** 参数类型（映射 opencode tool.schema 的 string()/boolean()/number()）。 */
export type CustomToolArgType = 'string' | 'boolean' | 'integer';

export interface CustomToolArg {
  /** 参数名（opencode tool.schema 的键）。 */
  name: string;
  type: CustomToolArgType;
  /** 是否必填（必填不带 .optional()）。 */
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
  /** 导出名；'default' 渲染为 export default（工具名 = 文件名）。 */
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

/** 渲染单个参数 schema（tool.schema.string()/.optional()/.describe()）。 */
function renderArgSchema(arg: CustomToolArg): string {
  const schemaType = arg.type === 'integer' ? 'number' : arg.type;
  const base = `tool.schema.${schemaType}()`;
  const schema = arg.required ? base : `${base}.optional()`;
  return `${schema}.describe(${JSON.stringify(arg.description)})`;
}

/**
 * 渲染 cli execute 体：spawnSync(command[0], [command.slice(1), ...cmdArgs])。
 * file 参数必须是字符串（F3：数组作 file 运行时抛 ERR_INVALID_ARG_TYPE）。
 */
function renderCliExecute(command: string[]): string {
  const fileLiteral = JSON.stringify(command[0] ?? '');
  const restLiteral = command.slice(1).map((s) => JSON.stringify(s)).join(', ');
  const spawnArgs = restLiteral ? `[${restLiteral}, ...cmdArgs]` : 'cmdArgs';
  const cmdLabel = command.join(' ');
  return [
    'async execute(args) {',
    '  const cmdArgs: string[] = [];',
    '  for (const [key, value] of Object.entries(args)) {',
    '    if (value === undefined || value === null || value === false) continue;',
    '    if (typeof value === "boolean") { cmdArgs.push(`--${key}`); continue; }',
    '    cmdArgs.push(String(value));',
    '  }',
    `  const result = spawnSync(${fileLiteral}, ${spawnArgs}, { encoding: "utf8" });`,
    '  if (result.status !== 0) {',
    '    const err = (result.stderr || result.stdout || "").trim();',
    `    throw new Error(\`${cmdLabel} failed (exit \${result.status}): \${err}\`);`,
    '  }',
    '  return result.stdout ?? "";',
    '}',
  ].join('\n');
}

/** 渲染 http execute 体：fetch 转发（args 序列化为 JSON body）。 */
function renderHttpExecute(
  url: string,
  method: string,
  headers?: Record<string, string>,
): string {
  const headersLiteral = headers ? JSON.stringify(headers) : 'undefined';
  return [
    'async execute(args) {',
    '  const hasArgs = args && Object.keys(args).length > 0;',
    `  const response = await fetch(${JSON.stringify(url)}, {`,
    `    method: ${JSON.stringify(method)},`,
    `    headers: ${headersLiteral},`,
    '    body: hasArgs ? JSON.stringify(args) : undefined,',
    '  });',
    '  if (!response.ok) {',
    `    throw new Error(\`HTTP ${method} ${url} failed: \${response.status} \${response.statusText}\`);`,
    '  }',
    '  return await response.text();',
    '}',
  ].join('\n');
}

/** 渲染单个工具导出（具名或默认）。 */
function renderToolExport(fileName: string, exp: CustomToolExport): string {
  const argLines = exp.args
    .map((arg) => `    ${arg.name}: ${renderArgSchema(arg)},`)
    .join('\n');

  let executeBody: string;
  switch (exp.execute.type) {
    case 'cli':
      executeBody = renderCliExecute(exp.execute.command);
      break;
    case 'http':
      executeBody = renderHttpExecute(
        exp.execute.url,
        exp.execute.method,
        exp.execute.headers,
      );
      break;
    case 'code':
      executeBody = ['async execute(args) {', exp.execute.code, '}'].join('\n');
      break;
  }
  // execute 体相对 tool() 内层缩进 2 空格
  const indentedExecute = executeBody
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

  const opener =
    exp.exportName === 'default'
      ? 'export default tool({'
      : `export const ${exp.exportName} = tool({`;

  return [
    opener,
    `  description: ${JSON.stringify(exp.description)},`,
    '  args: {',
    argLines,
    '  },',
    indentedExecute,
    '});',
  ].join('\n');
}

/**
 * 渲染 .opencode/tools/<fileName>.ts 文件内容。
 * 按需注入 import（tool 恒有；cli 额外 spawnSync；http/code 用全局 fetch 无需 import）。
 */
export function renderCustomToolFile(def: CustomToolFileDef): string {
  const imports = ['import { tool } from "@opencode-ai/plugin";'];
  if (def.exports.some((e) => e.execute.type === 'cli')) {
    imports.push('import { spawnSync } from "node:child_process";');
  }

  const bodies = def.exports.map((e) => renderToolExport(def.fileName, e));

  return [
    '/**',
    ' * 平台自定义工具（T4b 自动注入）——由 worker 从控制面 tools 资源拉取后渲染。',
    ' * 工具名规则（11 篇 §3.2）：默认导出 = 文件名；具名导出 = <文件名>_<导出名>。',
    ' * 工具名即权限 action（FR-48）。',
    ' */',
    ...imports,
    '',
    ...bodies,
    '',
  ].join('\n');
}
