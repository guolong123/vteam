/**
 * GIT_SSH_COMMAND 临时 key 凭证注入（T5，决策 2B / 17 篇 §6.1）。
 *
 * 最小链路：凭证来源 worker 环境变量（GIT_SSH_KEY_PATH）不入库；ssh 子进程经
 * `GIT_SSH_COMMAND="ssh -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=no"`
 * 使用临时 key，路径随机化（os.tmpdir()/keta-cred-<random>）、权限 600、用完即删
 * （17 篇 §5.4）。本任务只提供能力 + 单测，实际注入由 T3/T4 集成时使用返回的 env。
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 临时 key 文件前缀（17 篇 §5.4：路径随机化约定）。 */
export const TEMP_KEY_PREFIX = 'keta-cred-';

/** 默认临时 key 文件权限（仅属主可读写，17 篇 §5.4 安全基线）。 */
export const TEMP_KEY_MODE = 0o600;

/** 无 strict host checking（临时 key 场景免交互，D6 2B）。 */
const STRICT_HOST_KEY_CHECKING = 'no';

/**
 * git 凭证输入（当前仅 ssh key 一种形态；https token 留待下轮）。
 * 提供 keyPath 即使用；未提供时回退 config.gitSshKeyPath（GIT_SSH_KEY_PATH）。
 */
export interface GitCredential {
  /** SSH 私钥文件路径（createTempKey 返回值或已有 key）。 */
  keyPath?: string;
}

/** resolveGitEnv 构造选项。 */
export interface ResolveGitEnvOptions {
  /** 是否强制 IdentitiesOnly（缺省 true，只使用指定 key，17 篇 §6.1）。 */
  identitiesOnly?: boolean;
  /** StrictHostKeyChecking 值（缺省 'no'，D6 2B 免交互）。 */
  strictHostKeyChecking?: 'yes' | 'no' | 'ask';
}

/**
 * 构造 git 子进程注入 env（GIT_SSH_COMMAND）。
 * keyPath 解析顺序：credential.keyPath → config.gitSshKeyPath；两者皆空返回空 env（不注入）。
 */
export function resolveGitEnv(
  credential: GitCredential | undefined,
  config: { gitSshKeyPath?: string },
  options: ResolveGitEnvOptions = {},
): NodeJS.ProcessEnv {
  const keyPath = credential?.keyPath?.trim() || config.gitSshKeyPath?.trim();
  if (!keyPath) {
    return {};
  }
  const identitiesOnly = options.identitiesOnly ?? true;
  const strictHostKeyChecking = options.strictHostKeyChecking ?? STRICT_HOST_KEY_CHECKING;
  const command = `ssh -i ${keyPath} -o IdentitiesOnly=${identitiesOnly ? 'yes' : 'no'} -o StrictHostKeyChecking=${strictHostKeyChecking}`;
  return { GIT_SSH_COMMAND: command };
}

/** createTempKey 选项。 */
export interface CreateTempKeyOptions {
  /** 临时 key 所在目录；缺省 os.tmpdir()。 */
  dir?: string;
  /** 文件名前缀；缺省 keta-cred-（TEMP_KEY_PREFIX）。 */
  prefix?: string;
  /** 文件权限；缺省 0o600（TEMP_KEY_MODE）。 */
  mode?: number;
}

/**
 * 写临时 SSH 私钥文件（随机路径 + 权限 600），返回文件路径。
 * 调用方负责在 try/finally 中 cleanup 删除（17 篇 §4.3 execute 六步⑤）。
 */
export function createTempKey(contents: string, options: CreateTempKeyOptions = {}): string {
  const dir = options.dir ?? os.tmpdir();
  const prefix = options.prefix ?? TEMP_KEY_PREFIX;
  const mode = options.mode ?? TEMP_KEY_MODE;
  const random = crypto.randomBytes(16).toString('hex');
  const keyPath = path.join(dir, `${prefix}${random}`);
  fs.writeFileSync(keyPath, contents, { mode });
  fs.chmodSync(keyPath, mode);
  return keyPath;
}

/**
 * 删除临时 key 文件（幂等：文件不存在静默忽略）。
 * 覆盖成功/失败/超时全分支（17 篇 §5.4「用完即删」）。
 */
export function cleanup(keyPath: string): void {
  try {
    fs.unlinkSync(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
