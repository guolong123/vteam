import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GIT_TOOLS,
  GIT_TOOL_FILE,
  GIT_TOOLS_REL_DIR,
  installGitTools,
  renderGitToolsFile,
  GitToolDef,
} from './git-tools';

const EXPECTED_TOOL_NAMES = [
  'git_clone',
  'git_pull',
  'git_fetch',
  'git_status',
  'git_diff',
  'git_log',
  'git_push',
] as const;

describe('GIT_TOOLS 工具清单（17 篇 §4.1 七工具）', () => {
  it('含 7 个工具，名称对齐 §4.1', () => {
    expect(GIT_TOOLS).toHaveLength(7);
    expect(GIT_TOOLS.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('命名规则：name = <文件名>_<导出名>（git_<exportName>，文件名为 git）', () => {
    for (const tool of GIT_TOOLS) {
      expect(tool.name).toBe(`git_${tool.exportName}`);
      expect(tool.name.startsWith('git_')).toBe(true);
      expect(tool.exportName).not.toContain('_');
    }
  });

  it('默认 effect：push=ask（写远端），其余 allow', () => {
    const effects = Object.fromEntries(GIT_TOOLS.map((t) => [t.name, t.defaultEffect]));
    expect(effects.git_push).toBe('ask');
    for (const name of ['git_clone', 'git_pull', 'git_fetch', 'git_status', 'git_diff', 'git_log']) {
      expect(effects[name]).toBe('allow');
    }
  });

  it('关键参数对齐 §4.1：clone 必填 repo_url，push 必填 refspec', () => {
    const byName = (n: string): GitToolDef => GIT_TOOLS.find((t) => t.name === n)!;
    const clone = byName('git_clone');
    expect(clone.args.find((a) => a.name === 'repo_url')?.required).toBe(true);
    expect(clone.args.some((a) => a.name === 'ref')).toBe(true);
    expect(clone.args.some((a) => a.name === 'target')).toBe(true);

    const push = byName('git_push');
    expect(push.args.find((a) => a.name === 'refspec')?.required).toBe(true);
    expect(push.args.some((a) => a.name === 'repo_url')).toBe(true);
  });
});

describe('installGitTools / renderGitToolsFile（注入机制，17 篇 §4.2）', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-git-tools-spec-'));

  it('写入 <workDir>/.opencode/tools/git.ts 并返回完整路径', () => {
    const filePath = installGitTools(workDir);
    expect(filePath).toBe(path.join(workDir, GIT_TOOLS_REL_DIR, GIT_TOOL_FILE));
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('生成内容为 opencode 自定义工具具名导出格式', () => {
    const content = renderGitToolsFile();
    expect(content).toContain('import { tool } from "@opencode-ai/plugin";');
    expect(content).toContain('import { spawnSync } from "node:child_process";');
    for (const tool of GIT_TOOLS) {
      expect(content).toContain(`export const ${tool.exportName} = tool({`);
      expect(content).toContain(`description: ${JSON.stringify(tool.description)},`);
    }
    expect(content).toContain('function runGit(');
  });

  it('生成内容含全部参数 schema（inputSchema）', () => {
    const content = renderGitToolsFile();
    for (const tool of GIT_TOOLS) {
      for (const arg of tool.args) {
        expect(content).toContain(`${arg.name}: tool.schema.`);
      }
    }
  });

  it('注入到嵌套目录（mkdir recursive），文件内容可再生成（幂等覆盖）', () => {
    installGitTools(workDir);
    const first = fs.readFileSync(path.join(workDir, GIT_TOOLS_REL_DIR, GIT_TOOL_FILE), 'utf8');
    const again = installGitTools(workDir);
    expect(again).toBe(path.join(workDir, GIT_TOOLS_REL_DIR, GIT_TOOL_FILE));
    expect(fs.readFileSync(again, 'utf8')).toBe(first);
  });
});
