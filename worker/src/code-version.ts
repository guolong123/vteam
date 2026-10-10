/**
 * worker 代码版本解析（版本戳）。
 *
 * 注意命名：源码模块刻意**不叫** version.ts —— tsc 会把它编译成 dist/version.js，
 * 而 dist/version.js 正是 scripts/pack-worker.sh 生成的版本戳文件（同一路径，
 * 后者会覆盖前者）。运行时模块用 code-version.ts（产物 dist/code-version.js），
 * 版本戳文件保持 dist/version.js，两者并存不互相覆盖。
 *
 * 目的：worker 身份必须与发布物同源——pack 出的 tarball 用 git short SHA 戳版本
 * （scripts/pack-worker.sh 写 dist/version.js），容器/集群用 env 注入同一 SHA。
 * 三条来源同一份语义，优先级固定为：
 *
 *   1. env `WORKER_CODE_VERSION` —— 容器/集群注入（compose、chart ConfigMap、
 *      docker run -e），**优先级最高**：容器镜像由 Dockerfile ARG CODE_VERSION 转
 *      ENV，镜像里的 dist 无 version.js（worker/Dockerfile 直接 tsc 编译源码，
 *      不经 pack-worker.sh），env 是容器路径唯一来源；运行期 env 也可覆盖镜像 ENV。
 *   2. `dist/version.js` —— 打包脚本在 tsc 之后、tar 之前生成的版本戳文件
 *      （与 dist/index.js 同级）。**按文本读取而非 require**：worker 编译目标是
 *      CommonJS（tsconfig module=commonjs），而该文件由 shell 脚本生成、不经 tsc，
 *      require/import 会在模块缺失时抛错且把生成格式锁死为 CJS；文本解析对
 *      `export const`（ESM 写法）与 `exports.X =` 两种写法都成立，且不污染
 *      require 缓存（自更新覆盖 dist 后同进程再解析也能读到新值）。
 *   3. `'dev'` —— 开发态兜底（`npm run dev`/tsx 直跑 src，或旧包无 version.js）。
 *
 * 纯函数：文件读取经 `VersionFileReader` 注入，单测无需真实文件系统。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 开发态兜底版本（无 env、无版本戳文件时上报值）。 */
export const DEV_CODE_VERSION = 'dev';

/** 版本戳文件名（与 dist/index.js 同级，pack-worker.sh 生成）。 */
export const VERSION_FILE_BASENAME = 'version.js';

/** 版本来源 env 键名（容器/集群注入，优先级高于文件戳）。 */
export const CODE_VERSION_ENV_KEY = 'WORKER_CODE_VERSION';

/** env 视图：只需 WORKER_CODE_VERSION，ProcessEnv 天然兼容。 */
export type VersionEnv = Record<string, string | undefined>;

/**
 * 版本戳文件读取器：返回文件文本，缺失/不可读返回 undefined。
 * 默认实现读 dist/version.js（相对本模块 __dirname）。
 */
export type VersionFileReader = (filePath: string) => string | undefined;

/**
 * 默认读取器：同步读文件，任何失败（缺失/权限/路径非文件）都回退 undefined
 * （不抛错——开发态与历史发布包本就没有该文件，解析失败不应让 worker 起不来）。
 * 失败时 warn 一次便于排查「版本显示 dev」的原因。
 */
export const defaultVersionFileReader: VersionFileReader = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[version] 读取版本戳文件 ${filePath} 失败（${reason}），回落 ${DEV_CODE_VERSION}`);
    return undefined;
  }
};

/**
 * 从版本戳文件文本中解析版本串。
 *
 * 兼容 pack-worker.sh 生成的 `export const WORKER_CODE_VERSION = 'xxx';`
 * 以及 CommonJS 写法 `exports.WORKER_CODE_VERSION = "xxx";`（左边界允许 `.`，
 * 故 `exports.` 前缀同样命中）。左边界排除标识符字符，避免误取
 * `EXPECTED_WORKER_CODE_VERSION` 之类同后缀的其它常量。解析不出（空文件/注释掉/
 * 格式变更）返回 undefined，由 resolveCodeVersion 回退 'dev'。
 */
export function parseStampedVersion(content: string): string | undefined {
  const matched = /(?:^|[^\w$])WORKER_CODE_VERSION\s*=\s*(['"])([^'"\r\n]+)\1/.exec(content);
  return matched ? matched[2].trim() || undefined : undefined;
}

/**
 * 解析 worker 当前代码版本：env WORKER_CODE_VERSION > dist/version.js > 'dev'。
 *
 * @param env            环境变量视图（默认 process.env）
 * @param readVersionFile 版本戳文件读取器（默认读 __dirname/version.js），
 *                        注入点便于单测覆盖「文件缺失/损坏」分支
 */
export function resolveCodeVersion(
  env: VersionEnv = process.env,
  readVersionFile: VersionFileReader = defaultVersionFileReader,
): string {
  const fromEnv = (env[CODE_VERSION_ENV_KEY] ?? '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  const content = readVersionFile(path.join(__dirname, VERSION_FILE_BASENAME));
  const fromFile = content === undefined ? undefined : parseStampedVersion(content);
  if (fromFile) {
    return fromFile;
  }
  return DEV_CODE_VERSION;
}