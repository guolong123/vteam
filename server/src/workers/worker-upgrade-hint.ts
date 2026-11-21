/**
 * Worker **手动升级指引**（控制面下发给前端的一行可复制命令）。
 *
 * ── 为什么需要这个模块 ────────────────────────────────────────────────
 * 自更新不是所有节点都能用：
 * - **Windows 缺省关闭**（没有自动回滚，见 `worker-updater.ts` 的
 *   `WORKER_WINDOWS_SELF_UPDATE` 注释）；
 * - **旧版本 worker** 干脆没有重启桥；
 * - **Linux 无 systemd** 时替换完没人拉起新码。
 *
 * 此前这些节点在 UI 上「什么提示都没有」——用户以为已经是最新版。而 SCM 侧
 * `updateAvailable` 又依赖 `CODE_VERSION`，本地/内网部署常不配置它
 * ⇒ 连"待更新"都不会出现（静默，最差的一种）。
 *
 * 本模块给出与**安装方式无关的降级路径**：让用户复制一行命令自己执行。
 *
 * 铁律：**命令必须幂等且保留配置**。两条路径都已保证：
 * - Linux：`install-worker.sh` 重复执行 = 修复（保留 `.env` 的 token/密码）；
 * - Windows：`install-worker.ps1 -Force` = 升级（停旧 → 换 app → 重启 → 自检，保留 `.env`）。
 */

/** 安装方式（决定给哪一条命令）。 */
export type WorkerInstallKind = 'linux' | 'windows' | 'docker' | 'unknown';

/** 升级指引：给前端渲染成「点开 → 复制命令」。 */
export interface WorkerUpgradeHint {
  /** 该怎么升级（一句话，UI 副标题）。 */
  summary: string;
  /** 可直接复制执行的命令（按 `kind` 给出的那一条；无匹配时为空串）。 */
  command: string;
  /**
   * 命令适用的平台（前端可据此调整措辞）。
   * `unknown` = 认不出安装方式，只给通用说明（不瞎猜命令）。
   */
  kind: WorkerInstallKind;
  /**
   * 为什么不能一键自动升级（UI 用来说明原因，避免用户以为"按钮坏了"）。
   * 没有原因（可以自更新）时为 undefined。
   */
  reason?: string;
}

/** 判断 worker 的安装方式（据宿主标识 + 引擎推断，无法判定返回 unknown）。 */
export function resolveInstallKind(input: {
  /** worker 上报的主机名（Windows 主机名常见 `DESKTOP-xxxx`）。 */
  name?: string | null;
  /** 是否有 Windows 特有痕迹（未启用时为 undefined）。 */
  platform?: string | null;
}): WorkerInstallKind {
  const raw = (input.platform ?? '').trim().toLowerCase();
  if (raw === 'win32' || raw === 'windows') return 'windows';
  if (raw === 'linux') return 'linux';
  if (raw === 'docker') return 'docker';
  // 兜底：主机名形态（Windows 缺省主机名 DESKTOP-*；也是本仓库实测的 w_win_01 形态）
  const name = (input.name ?? '').trim().toUpperCase();
  if (name.startsWith('DESKTOP-') || name.startsWith('WIN-')) return 'windows';
  return 'unknown';
}

/**
 * 控制面对外基址（拼安装脚本地址用）。
 *
 * 为什么从 env 读而不是请求上下文：GET /workers 是**列表**接口，worker 各自去往
 * 不同地址没有意义；且本仓库既有 `install-worker.sh` 的下载地址就由调用方拼
 * （前端从 pageOrigin 推导）。这里给一个可覆盖的部署期常量即可，缺省用相对路径
 * （前端拿到 `/install-worker.sh` 后自行补 origin，最稳）。
 *
 * 优先级：`WORKER_PUBLIC_BASE_URL` > 空串（前端补 origin）。
 */
export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env['WORKER_PUBLIC_BASE_URL'] ?? '').trim().replace(/\/+$/, '');
}

/**
 * 命令里的控制面地址占位符。
 *
 * ── 为什么用占位符而不是直接拼绝对地址 ──────────────────────────────────
 * server 侧**不知道用户是用哪个地址打开控制面的**（本机 127.0.0.1、局域网 IP、
 * 反代域名…都不一定相同）。若 server 拼死一个地址，远程 Windows 用户复制到命令后
 * 会去打一个**它自己不可达**的地址（实测：拼出 `iwr /install-worker.ps1` 这种连域名
 * 都没有的命令）。
 *
 * 故 server 只给模板，由**浏览器侧**用 `window.location` 推导出真实可达的 server 地址
 * 再替换（前端已有 `pageOrigin` → serverUrl 的成熟逻辑，13001→13000）。
 */
export const UPGRADE_SERVER_PLACEHOLDER = '{{SERVER_URL}}';

/**
 * 升级命令里的**静态资源基址**占位符（脚本/tarball 由 web 静态服务提供）。
 *
 * ⚠️ 为什么必须与 `{{SERVER_URL}}` 分开（2026-11-21 线上 404 事故）：
 * `install-worker.ps1` / `install-worker.sh` / `worker-src.tar.gz` 都由 **web**
 * 静态目录提供（`web/public/`），而 `-Server` 指的是 **server API**。
 * 本地 compose 里那是**两个端口**（web 13001 / server 13000）；
 * 早先只用一个地址 ⇒ 命令去 `http://host:13000/install-worker.ps1` 取脚本
 * ⇒ `Cannot GET /install-worker.ps1` **404**，安装器连启动都启动不了。
 * 反代同域部署时两者可以相同（前端按 origin 推导，天然正确）。
 */
export const UPGRADE_WEB_PLACEHOLDER = '{{WEB_URL}}';

/**
 * 生成某安装方式的升级命令**模板**（地址位置用 `{{SERVER_URL}}` 占位）。
 *
 * 前端替换示例：`command.replaceAll('{{SERVER_URL}}', serverBase)`。
 */
export function commandFor(kind: WorkerInstallKind): string {
  const base = UPGRADE_SERVER_PLACEHOLDER;
  switch (kind) {
    case 'linux':
      // 脚本从 web 取；--server 指向 server API（两者在 compose 里是不同端口）
      return (
        `curl -fsSL ${UPGRADE_WEB_PLACEHOLDER}/install-worker.sh | bash -s -- ` +
        `--server ${base} -Force`
      );
    case 'windows':
      // -SrcUrl 显式指向 web 上的 tarball：安装器缺省会回退 `$Server/worker-src.tar.gz`
      // （那是 server 端口 ⇒ 404，线上实测），必须显式给。
      return (
        `powershell -NoProfile -ExecutionPolicy Bypass -Command ` +
        `"iwr ${UPGRADE_WEB_PLACEHOLDER}/install-worker.ps1 -OutFile $env:TEMP\\install-worker.ps1; ` +
        `& $env:TEMP\\install-worker.ps1 -Server ${base} ` +
        `-SrcUrl ${UPGRADE_WEB_PLACEHOLDER}/worker-src.tar.gz -Force"`
      );
    case 'docker':
      return `docker compose pull worker && docker compose up -d worker`;
    case 'unknown':
    default:
      return '';
  }
}

/**
 * 生成升级指引。
 *
 * @param input.canSelfUpdate - worker 上报的 `engineCapabilities.selfUpdate`；
 *   `true` 时**不需要**手动命令（返回 undefined）。
 * @param input.installKind - 安装方式。
 * @param input.serverUrl - 控制面基址（拼脚本下载地址）。
 * @param input.reason - 附加原因（如 Windows 未开自更新）。
 */
export function buildUpgradeHint(input: {
  canSelfUpdate: boolean | undefined;
  installKind: WorkerInstallKind;
  serverUrl: string;
  reason?: string;
}): WorkerUpgradeHint | undefined {
  if (input.canSelfUpdate === true) {
    return undefined;
  }
  const command = commandFor(input.installKind);
  const summaryByKind: Record<WorkerInstallKind, string> = {
    linux: '在 worker 主机上执行（幂等：保留 .env 的 token/密码）',
    windows: '在 worker 主机上以管理员 PowerShell 执行（重跑安装器 = 升级，保留 .env）',
    docker: '在 worker 所在主机执行（拉取新镜像并重建容器）',
    unknown: '未识别出安装方式：请重跑该节点原来的安装脚本（Linux 用 install-worker.sh，Windows 用 install-worker.ps1 -Force）',
  };
  return {
    summary: summaryByKind[input.installKind],
    command,
    kind: input.installKind,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

/**
 * 不可自更新的原因文案（给用户解释"为什么只能手动"）。
 *
 * 三种来源分开说，避免笼统的"不支持"：
 * - Windows 未开启：最可能是它，且用户能自己开（WORKER_WINDOWS_SELF_UPDATE=1）；
 * - 旧 worker 未上报：它在跑不认识自更新的老代码，只能重装；
 * - 其它：交给通用说明。
 */
export function selfUpdateDisabledReason(input: {
  installKind: WorkerInstallKind;
  /** worker 是否上报了 engineCapabilities.selfUpdate（undefined = 旧 worker）。 */
  reported: boolean | undefined;
}): string {
  if (input.reported === undefined) {
    return '该节点版本较旧，不支持自动升级';
  }
  if (input.installKind === 'windows') {
    return 'Windows 节点默认关闭自动升级（缺少自动回滚），需重跑安装器 -Force';
  }
  return '该节点不支持自动升级';
}
