/**
 * 平台内置 git 工具族定义与注入机制（T5，17 篇 §4）。
 *
 * 工具清单对齐 17 篇 §4.1（git_clone/git_pull/git_fetch/git_status/git_diff/git_log/git_push）；
 * 注入落点：worker 实例侧 .opencode/tools/git.ts（17 篇 §4.2 路径①：目录扫描自动注册）。
 * 单文件具名导出，工具名 = <文件名>_<导出名>（git.ts 导出 clone → git_clone），
 * 工具名即权限 action。本任务只提供工具定义与注入机制，execute 为最小实现
 * （调用本机 git 命令），真实凭证/清理逻辑留给运行期扩展。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 注入目标目录（相对 opencode serve 工作目录，17 篇 §4.2）。 */
export const GIT_TOOLS_REL_DIR = path.join('.opencode', 'tools');

/** 工具文件名（17 篇 §4.2 单文件具名导出形态）。 */
export const GIT_TOOL_FILE = 'git.ts';

/** 工具默认 effect（07 篇 §3.1：有副作用工具默认 ask）。 */
export type GitToolEffect = 'allow' | 'ask';

/** 工具参数定义（inputSchema 的声明式描述，渲染为 opencode tool.schema）。 */
export interface GitToolArg {
  /** 参数名（与 17 篇 §4.1 关键参数列一致）。 */
  name: string;
  /** schema 类型（渲染为 tool.schema.string()/boolean()/number()）。 */
  type: 'string' | 'boolean' | 'integer';
  /** 是否必填（必填不带 .optional()）。 */
  required: boolean;
  /** 参数描述。 */
  description: string;
}

/** 单个 git 工具定义。 */
export interface GitToolDef {
  /** 完整工具名 = <文件名>_<导出名>（如 git_clone），即权限 action。 */
  name: string;
  /** 导出标识（工具名规则中的 <导出名> 部分）。 */
  exportName: string;
  /** 工具描述。 */
  description: string;
  /** 默认 effect（permission 规则默认值）。 */
  defaultEffect: GitToolEffect;
  /** 参数定义（inputSchema）。 */
  args: GitToolArg[];
  /** execute 行为说明（渲染为生成文件内最小实现的引导注释）。 */
  executeHint: string;
}

/**
 * git 工具族清单（17 篇 §4.1 七工具）。
 * 写操作仅 git_push 默认 ask（写远端核心副作用），其余写本地/只读默认 allow。
 */
export const GIT_TOOLS: readonly GitToolDef[] = [
  {
    name: 'git_clone',
    exportName: 'clone',
    description: '克隆仓库到工作目录',
    defaultEffect: 'allow',
    args: [
      { name: 'repo_url', type: 'string', required: true, description: '仓库地址，如 git@gitee.com:xishuhq/ketaops.git' },
      { name: 'ref', type: 'string', required: false, description: '分支/标签，缺省取远端默认分支' },
      { name: 'target', type: 'string', required: false, description: '目标目录，缺省取仓库名' },
    ],
    executeHint: 'git clone [--branch ref] repo_url [target]',
  },
  {
    name: 'git_pull',
    exportName: 'pull',
    description: '拉取远端更新到当前工作区',
    defaultEffect: 'allow',
    args: [
      { name: 'repo_url', type: 'string', required: false, description: '仓库地址，缺省取当前目录 origin' },
    ],
    executeHint: 'git pull [repo_url]',
  },
  {
    name: 'git_fetch',
    exportName: 'fetch',
    description: '获取远端引用（不合并）',
    defaultEffect: 'allow',
    args: [
      { name: 'repo_url', type: 'string', required: false, description: '仓库地址，缺省取当前目录 origin' },
      { name: 'ref', type: 'string', required: false, description: '远端引用/分支' },
    ],
    executeHint: 'git fetch [repo_url] [ref]',
  },
  {
    name: 'git_status',
    exportName: 'status',
    description: '查看工作区/暂存区状态',
    defaultEffect: 'allow',
    args: [
      { name: 'porcelain', type: 'boolean', required: false, description: '以 --porcelain 机器可读格式输出' },
    ],
    executeHint: 'git status [--porcelain]',
  },
  {
    name: 'git_diff',
    exportName: 'diff',
    description: '查看工作区/提交间差异',
    defaultEffect: 'allow',
    args: [
      { name: 'ref_a', type: 'string', required: false, description: '对比基线提交/引用' },
      { name: 'ref_b', type: 'string', required: false, description: '对比目标提交/引用' },
      { name: 'path', type: 'string', required: false, description: '限定路径（传入 -- path）' },
    ],
    executeHint: 'git diff [ref_a] [ref_b] [-- path]',
  },
  {
    name: 'git_log',
    exportName: 'log',
    description: '查看提交历史',
    defaultEffect: 'allow',
    args: [
      { name: 'limit', type: 'integer', required: false, description: '限制条数（-n）' },
      { name: 'path', type: 'string', required: false, description: '限定路径（传入 -- path）' },
    ],
    executeHint: 'git log [-n limit] [-- path]',
  },
  {
    name: 'git_push',
    exportName: 'push',
    description: '推送本地提交到远端（写远端，默认 ask 确认流）',
    defaultEffect: 'ask',
    args: [
      { name: 'repo_url', type: 'string', required: false, description: '仓库地址，缺省取当前目录 origin' },
      { name: 'refspec', type: 'string', required: true, description: '推送引用规格，如 main:main' },
    ],
    executeHint: 'git push [repo_url] refspec',
  },
];

/**
 * 渲染 .opencode/tools/git.ts 文件内容（opencode 自定义工具具名导出格式）。
 * 导出名 → 工具名 <文件名>_<导出名>；execute 为调用本机 git 命令的最小实现。
 */
export function renderGitToolsFile(defs: readonly GitToolDef[] = GIT_TOOLS): string {
  const renderArgSchema = (arg: GitToolArg): string => {
    const schemaType = arg.type === 'integer' ? 'number' : arg.type;
    const base = `tool.schema.${schemaType}()`;
    const schema = arg.required ? base : `${base}.optional()`;
    return `${schema}.describe(${JSON.stringify(arg.description)})`;
  };

  const renderTool = (def: GitToolDef): string => {
    const argLines = def.args
      .map((arg) => `    ${arg.name}: ${renderArgSchema(arg)},`)
      .join('\n');
    return [
      `export const ${def.exportName} = tool({`,
      `  description: ${JSON.stringify(def.description)},`,
      `  args: {`,
      argLines,
      `  },`,
      `  async execute(args) {`,
      `    // ${def.executeHint}`,
      `    const gitArgs = _buildGitArgs("${def.exportName}", args);`,
      `    return runGit(gitArgs);`,
      `  },`,
      `});`,
    ].join('\n');
  };

  return [
    '/**',
    ' * 平台内置 git 工具族（17 篇 §4.1）——由 worker T5 自动注入。',
    ' * 工具名 = <文件名>_<导出名>（如 git_clone），即权限 action。',
    ' * execute 为最小实现：调用本机 git 命令；真实凭证/清理逻辑由运行期扩展。',
    ' */',
    'import { tool } from "@opencode-ai/plugin";',
    'import { spawnSync } from "node:child_process";',
    '',
    'function runGit(args: string[]): string {',
    '  const result = spawnSync("git", args, { encoding: "utf8" });',
    '  if (result.status !== 0) {',
    '    const err = (result.stderr || result.stdout || "").trim();',
    '    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${err}`);',
    '  }',
    '  return result.stdout ?? "";',
    '}',
    '',
    'function _buildGitArgs(exportName: string, args: Record<string, unknown>): string[] {',
    '  const a: string[] = [];',
    '  switch (exportName) {',
    '    case "clone":',
    '      a.push("clone");',
    '      if (args.ref) a.push("--branch", String(args.ref));',
    '      a.push(String(args.repo_url));',
    '      if (args.target) a.push(String(args.target));',
    '      break;',
    '    case "pull":',
    '      a.push("pull");',
    '      if (args.repo_url) a.push(String(args.repo_url));',
    '      break;',
    '    case "fetch":',
    '      a.push("fetch");',
    '      if (args.repo_url) a.push(String(args.repo_url));',
    '      if (args.ref) a.push(String(args.ref));',
    '      break;',
    '    case "status":',
    '      a.push("status");',
    '      if (args.porcelain) a.push("--porcelain");',
    '      break;',
    '    case "diff":',
    '      a.push("diff");',
    '      if (args.ref_a) a.push(String(args.ref_a));',
    '      if (args.ref_b) a.push(String(args.ref_b));',
    '      if (args.path) a.push("--", String(args.path));',
    '      break;',
    '    case "log":',
    '      a.push("log");',
    '      if (args.limit) a.push("-n", String(args.limit));',
    '      if (args.path) a.push("--", String(args.path));',
    '      break;',
    '    case "push":',
    '      a.push("push");',
    '      if (args.repo_url) a.push(String(args.repo_url));',
    '      a.push(String(args.refspec));',
    '      break;',
    '    default:',
    '      throw new Error(`unknown git tool export: ${exportName}`);',
    '  }',
    '  return a;',
    '}',
    '',
    ...defs.map(renderTool),
    '',
  ].join('\n');
}

/**
 * 把 git 工具族注入到 opencode serve 工作目录（worker 启动时调用，17 篇 §4.2）。
 * 写入 <workDir>/.opencode/tools/git.ts，返回写入的文件完整路径。
 */
export function installGitTools(workDir: string, defs: readonly GitToolDef[] = GIT_TOOLS): string {
  const toolsDir = path.join(workDir, GIT_TOOLS_REL_DIR);
  fs.mkdirSync(toolsDir, { recursive: true });
  const filePath = path.join(toolsDir, GIT_TOOL_FILE);
  fs.writeFileSync(filePath, renderGitToolsFile(defs), 'utf8');
  return filePath;
}
