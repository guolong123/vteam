/**
 * git-credentials 下行命令凭证落盘注入器（todo 3）。
 *
 * 注入通道：worker 幂等写 `$HOME/.keta-git-creds.json`（600 权限）。与 model-credentials
 * （auth.json 注入 + 重启 serve 生效）的关键区别：**不重启 serve**——git 工具每次执行
 * 读文件取凭证（todo 4 接线），写盘即生效。
 *
 * 格式：`{ version: 1, updatedAt: <ISO>, credentials: GitCredentialEntry[] }`。
 * key 为明文写入（权限 600 是唯一防线）；幂等对比按 repoUrl 排序（乱序输入 → 稳定输出），
 * 相同 entries 二次下发复用现有 updatedAt → 内容一致 → 跳过写盘（文件 mtime 不变）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 凭证文件权限（仅属主读写，明文 key 的唯一防线）。 */
export const GIT_CREDS_FILE_MODE = 0o600;

/** $HOME/.keta-git-creds.json（git 工具读文件取凭证，落盘即生效，不重启 serve）。 */
export const GIT_CREDS_FILE = path.join(os.homedir(), '.keta-git-creds.json');

/** 单条仓库凭证（repoUrl → 明文 SSH 私钥/HTTPS token，来自下行 git-credentials 命令）。 */
export interface GitCredentialEntry {
  repoUrl: string;
  /** 认证类型：ssh_key=SSH 私钥、https_token=HTTPS token（对齐 server GitCredentialEntry.authType）。 */
  authType: 'ssh_key' | 'https_token';
  key: string;
  /** 脱敏标识（透传落盘供审计比对，不含明文）。 */
  fingerprint: string;
  /** 该仓库在 worker 凭证面上的最高授权权限（write > read；git.ts push 工具据此校验 write）。 */
  permission?: string;
}

/** 凭证文件整体结构（readGitCredsFile 返回类型）。 */
export interface GitCredsFile {
  version: number;
  updatedAt: string;
  credentials: GitCredentialEntry[];
}

/** 写入结果（供调用方落盘路径确认）。 */
export interface GitCredsResult {
  /** 凭证文件完整路径（= $HOME/.keta-git-creds.json） */
  path: string;
}

/** 条目合法性判定（buildGitCredsFile 过滤 + handleGitCredentials 统计共用）。 */
export function isValidGitCredEntry(entry: GitCredentialEntry | undefined | null): boolean {
  return Boolean(entry && entry.repoUrl?.trim() && entry.key && entry.authType);
}

/**
 * 组装凭证文件内容（`{version:1, updatedAt, credentials}`）。
 * - **先按 repoUrl 升序排序**（乱序输入 → 稳定输出，幂等对比可靠）；
 * - 空/非法条目静默跳过（防御脏负载，不产生非法 JSON，仿 buildAuthJson）；
 * - updatedAt 默认取当前时间，可注入固定值（幂等对比复用现有文件 updatedAt）。
 */
export function buildGitCredsFile(
  entries: GitCredentialEntry[],
  updatedAt: string = new Date().toISOString(),
): string {
  const credentials = (entries ?? [])
    .filter(isValidGitCredEntry)
    .map((e) => ({
      repoUrl: e.repoUrl.trim(),
      authType: e.authType,
      key: e.key,
      fingerprint: e.fingerprint ?? '',
      permission: e.permission,
    }))
    .sort((a, b) => a.repoUrl.localeCompare(b.repoUrl));
  return JSON.stringify({ version: 1, updatedAt, credentials }, null, 2);
}

/**
 * 写凭证文件到 `$HOME/.keta-git-creds.json`：防御性 mkdir -p homedir +
 * writeFileSync（mode 600）+ chmodSync 兜底（仿 writeAuthJson/git-credentials 双保险）。
 * homedir 在函数内动态求值（模块级常量 GIT_CREDS_FILE 加载时固化，此处保证
 * 测试/运行时 mock 均生效）。返回 { path }。
 */
export function writeGitCredsFile(entries: GitCredentialEntry[]): GitCredsResult {
  const homedir = os.homedir();
  fs.mkdirSync(homedir, { recursive: true });
  const credsPath = path.join(homedir, '.keta-git-creds.json');
  fs.writeFileSync(credsPath, buildGitCredsFile(entries), {
    mode: GIT_CREDS_FILE_MODE,
  });
  fs.chmodSync(credsPath, GIT_CREDS_FILE_MODE);
  return { path: credsPath };
}

/**
 * 读取凭证文件（返回完整对象）；不存在/解析失败 → null（幂等对比与恢复路径共用）。
 */
export function readGitCredsFile(filePath = GIT_CREDS_FILE): GitCredsFile | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as GitCredsFile;
  } catch {
    return null;
  }
}

/** 删除凭证文件（幂等：不存在静默忽略；force 兜底，仿 cleanupAuthJson）。 */
export function cleanupGitCredsFile(filePath: string): void {
  if (!filePath) {
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
