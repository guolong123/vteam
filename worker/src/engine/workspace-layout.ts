/**
 * 工作区布局实现（P1 / 计划 A7 WorkspaceLayout）。
 *
 * 把 **vteam 自有资产**从**引擎私有目录**里拆出来：
 * - 既有实现把计划文档、技能源散落在 `.opencode/plans`、`.opencode/skills`、`.omo/*` 等
 *   **引擎约定目录**，接第二个引擎时又要一份约定（server 的 `/plan-files` 也得跟着改）。
 * - 抽象后：vteam 资产固定 `.vteam/`，引擎只在注入时决定如何挂载/读取。
 *
 * 兼容策略（P1 不破坏现有 worker）：**双读**——`resolvePlansDir()` 在 `.vteam/plans`
 * 不存在时回落到既有 `.opencode/plans`，保证老工作目录继续可用；新会话写 `.vteam/`。
 *
 * @module engine/workspace-layout
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { WorkerEngineKind, WorkspaceLayout } from './types';

/** vteam 自有资产根目录名（引擎无关）。 */
export const VTEAM_ROOT_DIRNAME = '.vteam';
/** 计划文档子目录。 */
export const VTEAM_PLANS_DIRNAME = 'plans';
/** 系统提示词交接子目录（各引擎自行读取）。 */
export const VTEAM_SYSTEM_HANDOFF_DIRNAME = 'system-handoff';
/** 技能源子目录。 */
export const VTEAM_SKILLS_DIRNAME = 'skills';

/** 既有 opencode 计划目录（兼容回落用）。 */
export const LEGACY_PLANS_DIRNAME = join('.opencode', 'plans');

export interface WorkspaceLayoutOptions {
  /** 引擎类型（仅用于诊断/日志；目录布局本身引擎无关）。 */
  kind?: WorkerEngineKind;
  /** vteam 资产根（缺省 `<workDir>/.vteam`）。 */
  vteamRoot?: string;
  /** 兼容回落的既有计划目录（缺省 `<workDir>/.opencode/plans`）。 */
  legacyPlansDir?: string;
}

/** `WorkspaceLayout` 的具体实现。 */
export class DefaultWorkspaceLayout implements WorkspaceLayout {
  readonly vteamRoot: string;
  readonly plansDir: string;
  readonly systemHandoffDir: string;
  readonly skillsSourceDir: string;

  /** 兼容回落目录（既有 `.opencode/plans`）；不存在时不回落。 */
  private readonly legacyPlansDir: string;

  constructor(workDir: string, options: WorkspaceLayoutOptions = {}) {
    this.vteamRoot = options.vteamRoot ?? join(workDir, VTEAM_ROOT_DIRNAME);
    this.plansDir = join(this.vteamRoot, VTEAM_PLANS_DIRNAME);
    this.systemHandoffDir = join(this.vteamRoot, VTEAM_SYSTEM_HANDOFF_DIRNAME);
    this.skillsSourceDir = join(this.vteamRoot, VTEAM_SKILLS_DIRNAME);
    this.legacyPlansDir = options.legacyPlansDir ?? join(workDir, LEGACY_PLANS_DIRNAME);
  }

  /**
   * 计划文档**实际读取**目录（双读兼容）。
   *
   * - `.vteam/plans` 存在 → 用它（新布局）；
   * - 否则回落既有 `.opencode/plans`（老工作目录）；
   * - 两者都没有 → 返回新布局路径（调用方按"空目录"处理，不报错）。
   *
   * 为什么不是构造期决定：工作目录可能在调用 `resolve` 之前才被创建/迁移，
   * 延迟判断才能反映磁盘真实状态。
   */
  resolvePlansDir(): string {
    if (existsSync(this.plansDir)) return this.plansDir;
    if (existsSync(this.legacyPlansDir)) return this.legacyPlansDir;
    return this.plansDir;
  }

  /** 兼容回落目录（诊断/迁移用）。 */
  get legacyPlansPath(): string {
    return this.legacyPlansDir;
  }
}

/**
 * 构造工作区布局（便捷入口；P1 各引擎共用同一实现——布局本身与引擎无关）。
 *
 * @param workDir - 会话工作目录。
 * @param options - 覆盖项（测试用）。
 */
export function createWorkspaceLayout(
  workDir: string,
  options?: WorkspaceLayoutOptions,
): DefaultWorkspaceLayout {
  return new DefaultWorkspaceLayout(workDir, options);
}
