/**
 * worker 手动升级指引 单测。
 *
 * ── 为什么值得测 ──────────────────────────────────────────────────────
 * 这段代码决定「用户在界面上看到什么」，而且它的**失败形态是静默的**：
 * 一旦 `upgradeHint` 算成 undefined 或命令拼错，用户看到的只是"没有升级提示"
 * 或"复制了一条跑不通的命令"——两种都不会报错。
 *
 * 三条必须钉死的语义：
 * 1. **能自更新的节点不给手动命令**（否则用户会去手动重装，白折腾）；
 * 2. **不能自更新的节点必须给命令**（Windows/旧 worker）；
 * 3. 认不出安装方式时**不瞎猜命令**（给空串 + 文字说明，让用户重跑原安装脚本）。
 */

import {
  buildUpgradeHint,
  resolveCanSelfUpdate,
  resolveInstallKind,
  selfUpdateDisabledReason,
  UPGRADE_SERVER_PLACEHOLDER,
  UPGRADE_WEB_PLACEHOLDER,
} from './worker-upgrade-hint';

describe('resolveInstallKind（安装方式判定）', () => {
  it('主机名 DESKTOP-* / WIN-* → windows（Windows 缺省命名，也是实测的 w_win_01 形态）', () => {
    expect(resolveInstallKind({ name: 'DESKTOP-H1KIHCR' })).toBe('windows');
    expect(resolveInstallKind({ name: 'win-server01' })).toBe('windows');
  });

  it('显式 platform 优先于主机名推断', () => {
    expect(resolveInstallKind({ name: 'DESKTOP-abc', platform: 'linux' })).toBe(
      'linux',
    );
    expect(resolveInstallKind({ name: 'foo', platform: 'win32' })).toBe(
      'windows',
    );
  });

  it('认不出 → unknown（不瞎猜）', () => {
    expect(resolveInstallKind({ name: 'f90fb5d058cb' })).toBe('unknown');
    expect(resolveInstallKind({})).toBe('unknown');
  });
});

describe('resolveCanSelfUpdate（旧 worker 回退到历史升级策略）', () => {
  it('已上报能力位 → 原样采信（true / false 都不推断）', () => {
    expect(
      resolveCanSelfUpdate({ reported: true, installKind: 'windows' }),
    ).toBe(true);
    expect(
      resolveCanSelfUpdate({ reported: false, installKind: 'linux' }),
    ).toBe(false);
  });

  it('未上报 + Linux/未知平台 → 可按一键自更新（回归：Linux 老节点不再退化成升级命令）', () => {
    expect(
      resolveCanSelfUpdate({ reported: undefined, installKind: 'linux' }),
    ).toBe(true);
    expect(
      resolveCanSelfUpdate({ reported: undefined, installKind: 'unknown' }),
    ).toBe(true);
    expect(
      resolveCanSelfUpdate({ reported: undefined, installKind: 'docker' }),
    ).toBe(true);
  });

  it('未上报 + Windows → 仍按不能自更新（升级命令）', () => {
    expect(
      resolveCanSelfUpdate({ reported: undefined, installKind: 'windows' }),
    ).toBe(false);
  });
});

describe('buildUpgradeHint（升级指引）', () => {
  const SERVER = 'http://10.0.0.5:13000';

  it('能自更新（canSelfUpdate=true）→ 不给手动命令', () => {
    expect(
      buildUpgradeHint({
        canSelfUpdate: true,
        installKind: 'linux',
        serverUrl: SERVER,
      }),
    ).toBeUndefined();
  });

  it('Windows 不能自更新 → 给 install-worker.ps1 -Force 命令（保留 .env 的幂等升级）', () => {
    const hint = buildUpgradeHint({
      canSelfUpdate: false,
      installKind: 'windows',
      serverUrl: SERVER,
      reason: 'Windows 缺省关闭自动升级',
    });
    expect(hint).toBeDefined();
    expect(hint!.kind).toBe('windows');
    expect(hint!.command).toContain('install-worker.ps1');
    // -Force 是 Windows 侧的"升级"开关（不带只是修复）
    expect(hint!.command).toContain('-Force');
    // 地址用占位符：server 不知道用户从哪个 origin 访问（前端替换）
    expect(hint!.command).toContain(UPGRADE_SERVER_PLACEHOLDER);
    expect(hint!.command).toContain(UPGRADE_WEB_PLACEHOLDER);
    expect(hint!.reason).toBe('Windows 缺省关闭自动升级');
  });

  it('Linux 不能自更新 → 给 curl install-worker.sh 命令', () => {
    const hint = buildUpgradeHint({
      canSelfUpdate: false,
      installKind: 'linux',
      serverUrl: SERVER,
    });
    expect(hint!.command).toContain('install-worker.sh');
    expect(hint!.command).toContain(UPGRADE_SERVER_PLACEHOLDER);
  });

  it('docker → 给 compose 命令（不是 install-worker.sh）', () => {
    const hint = buildUpgradeHint({
      canSelfUpdate: false,
      installKind: 'docker',
      serverUrl: SERVER,
    });
    expect(hint!.command).toContain('docker compose');
    expect(hint!.command).not.toContain('install-worker.sh');
  });

  it('unknown → 命令为空串但**仍然给说明**（UI 据此只显示文字，不显示复制按钮）', () => {
    const hint = buildUpgradeHint({
      canSelfUpdate: false,
      installKind: 'unknown',
      serverUrl: SERVER,
    });
    expect(hint).toBeDefined();
    expect(hint!.command).toBe('');
    expect(hint!.summary).toContain('install-worker');
  });

  /**
   * 线上 404 事故的回归闸门（2026-11-21）。
   *
   * 命令里**必须**区分两个地址：
   * - 脚本 / tarball 由 **web** 静态目录提供；
   * - `-Server` 是 **server API**。
   * 本地 compose 是 web 13001 / server 13000 两个端口；早年混用同一个地址
   * ⇒ `iwr http://host:13000/install-worker.ps1` 得到
   * `Cannot GET /install-worker.ps1` **404**，安装器根本起不来。
   */
  it('Windows 命令：脚本与 tarball 走 WEB 地址，-Server 走 SERVER 地址', () => {
    const hint = buildUpgradeHint({
      canSelfUpdate: false,
      installKind: 'windows',
      serverUrl: SERVER,
    });
    // 脚本下载 + -SrcUrl 都必须是 WEB 占位符
    expect(hint!.command).toContain(
      `${UPGRADE_WEB_PLACEHOLDER}/install-worker.ps1`,
    );
    expect(hint!.command).toContain(
      `${UPGRADE_WEB_PLACEHOLDER}/worker-src.tar.gz`,
    );
    // -Server 必须是 SERVER 占位符
    expect(hint!.command).toContain(`-Server ${UPGRADE_SERVER_PLACEHOLDER}`);
    // 关键：脚本地址绝不能是 SERVER 占位符（那就是 404 的成因）
    expect(hint!.command).not.toContain(
      `${UPGRADE_SERVER_PLACEHOLDER}/install-worker.ps1`,
    );
    // -SrcUrl 必须显式给（缺省会回退 $Server/worker-src.tar.gz ⇒ 404）
    expect(hint!.command).toContain('-SrcUrl');
  });

  it('Linux 命令：脚本走 WEB 地址，--server 走 SERVER 地址', () => {
    const hint = buildUpgradeHint({
      canSelfUpdate: false,
      installKind: 'linux',
      serverUrl: SERVER,
    });
    expect(hint!.command).toContain(
      `${UPGRADE_WEB_PLACEHOLDER}/install-worker.sh`,
    );
    expect(hint!.command).toContain(`--server ${UPGRADE_SERVER_PLACEHOLDER}`);
    expect(hint!.command).not.toContain(
      `${UPGRADE_SERVER_PLACEHOLDER}/install-worker.sh`,
    );
  });

  it('占位符后紧跟单斜杠（前端替换后不会出现 //）', () => {
    const hint = buildUpgradeHint({
      canSelfUpdate: false,
      installKind: 'linux',
      serverUrl: SERVER,
    });
    // 脚本地址用 WEB 占位符（不是 SERVER），且替换后不会出现双斜杠
    expect(hint!.command).toContain(
      `${UPGRADE_WEB_PLACEHOLDER}/install-worker.sh`,
    );
    expect(hint!.command).not.toContain('//install-worker.sh');
  });

  it('canSelfUpdate=undefined（旧 worker 未上报）→ 按"不能自更新"给命令', () => {
    // 关键：不能假设旧 worker 能自更新 —— 它连重启桥都没有。
    const hint = buildUpgradeHint({
      canSelfUpdate: undefined,
      installKind: 'windows',
      serverUrl: SERVER,
    });
    expect(hint).toBeDefined();
    expect(hint!.command).not.toBe('');
  });
});

describe('selfUpdateDisabledReason（解释为什么不给一键升级）', () => {
  it('未上报（旧 worker）→ 说明版本较旧', () => {
    expect(
      selfUpdateDisabledReason({ installKind: 'unknown', reported: undefined }),
    ).toContain('版本较旧');
  });

  it('Windows 明确关闭 → 说明原因（用户能自己开）', () => {
    const reason = selfUpdateDisabledReason({
      installKind: 'windows',
      reported: false,
    });
    expect(reason).toContain('Windows');
    expect(reason).toContain('-Force');
  });

  it('旧 Windows worker（未上报）→ 也按 Windows 解释，不说"版本较旧"误导用户', () => {
    const reason = selfUpdateDisabledReason({
      installKind: 'windows',
      reported: undefined,
    });
    expect(reason).toContain('Windows');
    expect(reason).not.toContain('版本较旧');
  });

  it('其它平台 → 通用说明（不含 Windows 字样）', () => {
    const reason = selfUpdateDisabledReason({
      installKind: 'linux',
      reported: false,
    });
    expect(reason).not.toContain('Windows');
    expect(reason).toContain('不支持自动升级');
  });
});
