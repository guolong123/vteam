/**
 * 控制面 POSIX 工作区路径 → Windows 本地路径的兼容垫片（Windows 原生支持）。
 *
 * 背景（Windows 真机实测，2026-11-14）：
 * - 控制面按 Linux 约定下发**绝对**工作目录：`/data/vteam-worker/...`
 *   （`server/src/tasks/work-dir.util.ts`、`server/src/teams/teams.service.ts`）。
 * - Windows worker 的 `WORK_DIR` 是 `C:\ProgramData\vteam-worker\work`，两者对不上。
 * - opencode v2 的 agent 是**按目录发现**的（`GET /api/agent?location[directory]=<dir>`
 *   只返回该目录下 `opencode.json` 定义的 agent，**不上溯父目录**——实测
 *   `<work>\.opencode` 目录只返回原生 agent）。控制面把会话目录切到
 *   `/data/vteam-worker/teams/tm_xxx` 后，serve 在该目录看不到 `opencode.json`
 *   ⇒ 角色 agent（`vteam-*`）全部不可见 ⇒ 执行期 `Agent not found: "vteam-project_manager"`。
 *   （对照实测：`/agents?directory=<workDir>` 返回 14 个 agent 含全部 vteam-*；
 *   `/agents?directory=/data/vteam-worker/teams/tm_xxx` 只返回 7 个原生 agent。）
 *
 * 本垫片的做法（仅 win32 生效，POSIX 原样返回，零行为变化）：
 * 1. 把 `/data/vteam-worker` 前缀映射到 worker 的 `WORK_DIR`（会话目录、/file 路径等）；
 * 2. 目标目录 ≠ WORK_DIR 时，把 `opencode.json` 与 `.opencode/` **物化**（拷贝）进去，
 *    让 serve 在该目录也能发现角色 agent / 项目插件（幂等；失败只告警不阻断）。
 *
 * ⚠️ 这是**临时垫片**。长期方案应由控制面感知每个 worker 的工作区根
 * （worker 上报 `capabilities.workspaceRoot`，server 用它拼实例/任务目录，或直接下发
 * 相对路径），届时删除本模块。
 *
 * @module runtime/workspace-path-shim
 */

import * as fs from 'fs';
import * as path from 'path';

/** 控制面硬编码的 POSIX 工作区根（与 server 侧 DEFAULT_TASK_WORK_DIR 同值）。 */
export const POSIX_WORKSPACE_ROOT = '/data/vteam-worker';

/** 最小日志接口（与 worker 其它模块同形，避免跨层依赖）。 */
export interface WorkspaceShimLogger {
  warn(message: string): void;
}

/**
 * POSIX 工作区路径 → 本地路径（仅 win32 生效）。
 *
 * @param directory 控制面下发的目录（可能是 `/data/vteam-worker/...`，也可能是本地路径）
 * @param workDir   worker 的 WORK_DIR（本地绝对路径）
 * @param platform  平台（默认 process.platform；单测注入）
 */
export function toLocalWorkspacePath(
  directory: string,
  workDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || !directory || !workDir) {
    return directory;
  }
  const normalized = directory.replace(/\\/g, '/');
  if (normalized === POSIX_WORKSPACE_ROOT) {
    return workDir;
  }
  if (normalized.startsWith(`${POSIX_WORKSPACE_ROOT}/`)) {
    return path.join(workDir, normalized.slice(POSIX_WORKSPACE_ROOT.length + 1));
  }
  return directory;
}

/**
 * 把项目配置物化到目标目录（仅 win32；目标 == WORK_DIR 时 no-op）。
 *
 * 为什么需要：serve 只按「会话目录」发现 `opencode.json`／`.opencode/`，不上溯父目录；
 * 控制面会把会话切到 `<workDir>/teams/<id>`、`<workDir>/<agent名>` 等子目录。
 * 拷贝量很小（配置文件 + 注入的插件/技能），且幂等（已存在则不覆盖）。
 *
 * 失败只告警：配置物化失败不应让 worker 崩；执行期会以 `Agent not found` 暴露（可排查）。
 */
export function materializeProjectConfig(
  workDir: string,
  targetDir: string,
  logger?: WorkspaceShimLogger,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || !workDir || !targetDir) {
    return;
  }
  if (path.resolve(targetDir) === path.resolve(workDir)) {
    return;
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const srcConfig = path.join(workDir, 'opencode.json');
    const dstConfig = path.join(targetDir, 'opencode.json');
    if (fs.existsSync(srcConfig) && !fs.existsSync(dstConfig)) {
      fs.copyFileSync(srcConfig, dstConfig);
    }
    const srcDot = path.join(workDir, '.opencode');
    const dstDot = path.join(targetDir, '.opencode');
    if (fs.existsSync(srcDot) && !fs.existsSync(dstDot)) {
      fs.cpSync(srcDot, dstDot, { recursive: true });
    }
  } catch (err) {
    logger?.warn(
      `[workspace-shim] 物化项目配置失败（${targetDir}）：${(err as Error).message}`,
    );
  }
}
