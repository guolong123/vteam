/**
 * C5b：模型凭据 auth.json 注入器（opencode 1.18.16 实测路径结论写死于此）。
 *
 * 注入通道：worker 直接写 `$HOME/.local/share/opencode/auth.json`（600 权限）。
 * opencode 1.18.16 实测凭据**固定**读该路径（`opencode auth list` 只认
 * `~/.local/share/opencode/auth.json`），`XDG_DATA_HOME` 不参与 auth.json 查找
 * （C5a 旧结论失效）。serve 为 spawn 子进程且 env=`{...process.env}`，继承 HOME
 * 即可读到同一路径，无需设置任何额外环境变量。
 *
 * 格式（实测）：`{ providerID: { type: 'api', key } }`。
 * token 为明文写入（权限 600 是唯一防线），退出/下次写入前 cleanup 删除文件
 * （明文 key 零留存；只删 auth.json 文件，不删 $HOME/.local/share/opencode 目录
 * —— 内含 opencode.db 会话库）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** auth.json 文件权限（仅属主读写，明文 key 的唯一防线）。 */
export const AUTH_FILE_MODE = 0o600;

/** $HOME/.local/share/opencode（auth.json 所在目录，opencode 1.18.16 实测固定读取位置）。 */
const OPENCODE_DATA_REL = ['.local', 'share', 'opencode'];

/** 单条凭据（provider → 明文 API key，来自下行 model-credentials 命令）。 */
export interface ModelCredentialEntry {
  providerID: string;
  key: string;
}

/** 注入结果（供调用方后续 cleanup）。 */
export interface AuthJsonResult {
  /** auth.json 完整路径（= $HOME/.local/share/opencode/auth.json） */
  authJsonPath: string;
}

/**
 * 组装 auth.json 内容（实测格式 `{providerID: {type:'api', key}}`）。
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
 * 写 auth.json 到 `$HOME/.local/share/opencode/auth.json`（opencode 1.18.16 实测
 * 固定读取路径）：写前 mkdir -p（含 log 子目录，serve 启动写
 * `$HOME/.local/share/opencode/log/opencode.log`，缺失会 FileSystem.open 崩溃 →
 * serve 退出 → worker 重启换端口循环）+ writeFileSync（mode 600）+ chmodSync 兜底
 * （仿临时 key 写入双保险）。返回 { authJsonPath }。
 */
export function writeAuthJson(providerKeys: ModelCredentialEntry[]): AuthJsonResult {
  const opencodeDataDir = path.join(os.homedir(), ...OPENCODE_DATA_REL);
  const authJsonPath = path.join(opencodeDataDir, 'auth.json');
  fs.mkdirSync(opencodeDataDir, { recursive: true });
  fs.mkdirSync(path.join(opencodeDataDir, 'log'), { recursive: true });
  fs.writeFileSync(authJsonPath, buildAuthJson(providerKeys), {
    mode: AUTH_FILE_MODE,
  });
  fs.chmodSync(authJsonPath, AUTH_FILE_MODE);
  return { authJsonPath };
}

/**
 * 删除 auth.json 文件（幂等：不存在静默忽略；仿临时 key 清理幂等）。
 * 只删文件本身，**不删** $HOME/.local/share/opencode 目录（内含 opencode.db
 * 会话库，误删会导致 serve 会话状态丢失）。
 * serve 已读取 auth.json 后调用（凭据进内存后落盘明文不留存）。
 */
export function cleanupAuthJson(authJsonPath: string): void {
  if (!authJsonPath) {
    return;
  }
  try {
    fs.rmSync(authJsonPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
