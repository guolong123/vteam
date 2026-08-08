/**
 * C5：模型凭据 auth.json 注入器（C5a 实测结论写死于此）。
 *
 * 注入通道：worker 进程设置 `XDG_DATA_HOME=<worker-data-dir>` + 写
 * `<data-dir>/opencode/auth.json`（600 权限）——opencode serve 启动时读取
 * `$XDG_DATA_HOME/opencode/auth.json`（优先级高于 `$HOME/.local/share`，C5a 实验 3
 * 决定性证据）；serve 为 spawn 子进程且 env=`{...process.env}`（opencode-server.ts:282），
 * 设置一次进程级 env 即自动继承，无需改 spawnServe 签名。
 *
 * 格式（C5a 实测）：`{ providerID: { type: 'api', key } }`。
 * token 为明文写入（C5a 确认权限 600 是唯一防线），路径随机化 + 用完 cleanup
 * （先例 git-credentials.ts:74-97：临时文件 600 + cleanup 幂等）。
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** auth.json 数据目录前缀（仿 git-credentials.ts TEMP_KEY_PREFIX 路径随机化约定）。 */
export const AUTH_DIR_PREFIX = 'keta-auth-';

/** auth.json 文件权限（仅属主读写，C5a 安全基线——明文 key 的唯一防线）。 */
export const AUTH_FILE_MODE = 0o600;

/** 单条凭据（provider → 明文 API key，来自下行 model-credentials 命令）。 */
export interface ModelCredentialEntry {
  providerID: string;
  key: string;
}

/** 注入结果（供调用方设置 XDG_DATA_HOME + 后续 cleanup）。 */
export interface AuthJsonResult {
  /** worker 数据目录（XDG_DATA_HOME 注入目标，opencode/auth.json 在其下） */
  dataDir: string;
  /** auth.json 完整路径 */
  authJsonPath: string;
}

/**
 * 组装 auth.json 内容（C5a 实测格式 `{providerID: {type:'api', key}}`）。
 * 空/空白 providerID 或空 key 的条目静默跳过（防御脏负载，不产生非法 JSON）。
 */
export function buildAuthJson(providerKeys: ModelCredentialEntry[]): string {
  const map: Record<string, { type: 'api'; key: string }> = {};
  for (const entry of providerKeys ?? []) {
    const providerID = entry?.providerID?.trim();
    if (providerID && entry.key) {
      map[providerID] = { type: 'api', key: entry.key };
    }
  }
  return JSON.stringify(map, null, 2);
}

/**
 * 写 auth.json：mkdir -p `<dir>/opencode` + writeFileSync（mode 600）+ chmodSync 兜底
 * （仿 git-credentials.ts createTempKey 双保险）。dir 缺省 = os.tmpdir()/keta-auth-<random>
 * （路径随机化，避免固定路径被预知/串扰）。返回 dataDir + authJsonPath。
 */
export function writeAuthJson(
  providerKeys: ModelCredentialEntry[],
  options: { dir?: string } = {},
): AuthJsonResult {
  const dataDir =
    options.dir ??
    path.join(os.tmpdir(), `${AUTH_DIR_PREFIX}${crypto.randomBytes(16).toString('hex')}`);
  const authJsonPath = path.join(dataDir, 'opencode', 'auth.json');
  fs.mkdirSync(path.dirname(authJsonPath), { recursive: true });
  fs.writeFileSync(authJsonPath, buildAuthJson(providerKeys), {
    mode: AUTH_FILE_MODE,
  });
  fs.chmodSync(authJsonPath, AUTH_FILE_MODE);
  return { dataDir, authJsonPath };
}

/**
 * 删除凭据数据目录（幂等：不存在静默忽略；仿 git-credentials.ts cleanup）。
 * serve 已读取 auth.json 后调用（凭据进内存后落盘明文不留存）。
 */
export function cleanupAuthJson(dataDir: string): void {
  if (!dataDir) {
    return;
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
