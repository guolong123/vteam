/**
 * worker 代码版本通道（worker-self-update Todo 2）的两把尺子。
 *
 * 「当前版本」由 worker 随 register/heartbeat 上报（落 `workers.code_version`）；
 * 「期望版本」是 server 自己的部署期常量 `CODE_VERSION`（deploy-k8s.sh 以
 * `--set server.env.codeVersion=$TAG` 注入，与 pack-worker tarball 同源）。
 *
 * 两者都是**自由文本**，故本模块只做「归一化 + 诚实缺省」，不做数值/语义校验：
 *   - 上报值缺席或为空串 → undefined（= 版本未知），绝不写 null 覆盖已有事实；
 *   - 超长值截断到列宽 191（MySQL 严格模式下的 1406 会让整个注册/心跳失败，
 *     而截断只损失展示精度——版本串本身只是给人眼比对用的短标识）。
 */

/** server env 名：期望代码版本（与 chart `server.env.codeVersion`、configmap `CODE_VERSION` 同源）。 */
export const CODE_VERSION_ENV_KEY = 'CODE_VERSION';

/** `workers.code_version` 列宽（varchar(191)），上报值超长时的截断上限。 */
export const WORKER_CODE_VERSION_MAX_LENGTH = 191;

/**
 * 归一化 worker 上报的 codeVersion。
 * undefined / null / 空串 / 纯空白 → undefined（调用方据此**不写该列**）；
 * 否则 trim 后截断到 {@link WORKER_CODE_VERSION_MAX_LENGTH}。
 */
export function normalizeReportedCodeVersion(
  raw: string | null | undefined,
): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > WORKER_CODE_VERSION_MAX_LENGTH
    ? trimmed.slice(0, WORKER_CODE_VERSION_MAX_LENGTH)
    : trimmed;
}

/**
 * 读 server env `CODE_VERSION` → 心跳响应的 `expectedVersion`。
 * 缺省/空串/纯空白 → undefined，调用方**整字段省略**（不下发 = 无更新语义，
 * 本地开发栈与未设该 env 的部署不会凭空长出「版本不一致」）。
 * 每次心跳实时读取（非模块加载时快照），便于运维改 env 后重启即生效、测试可注入。
 */
export function resolveExpectedCodeVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return normalizeReportedCodeVersion(env[CODE_VERSION_ENV_KEY]);
}