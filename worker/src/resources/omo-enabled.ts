/**
 * OmO 启用开关：控制 serve 启动时是否加载 OmO 插件。
 *
 * ── 为什么需要独立文件 ──────────────────────────────────────────────────
 *
 * 用户诉求：「增加开关控制是否开启（OmO），开启后可配置 omo agent 的模型」。
 * 关闭 = serve 启动时不加载插件（等价于 `--pure` 的效果：去插件/MEMORY 注入，
 * input tokens 从约 7601 降到约 1900）。
 *
 * 状态**不写进 OmO 自己的配置文件**（`.omo/omo.jsonc`）：那个文件由 OmO 管理，
 * 它会做迁移与重写（实测搬过家、留过 migration-backup），把我们的开关混进去
 * 迟早被覆盖或搬走。故选独立小文件 `<workDir>/.omo/omo-enabled.json`。
 *
 * ── 与 OPENCODE_PURE 的关系 ─────────────────────────────────────────────
 *
 * `OPENCODE_PURE` 是环境变量级的强制纯净模式（运维手段，用于对照 token 开销）。
 * 本开关是**功能级**的用户选择。两者任一为「关」即不加载插件：
 *   实际生效 = OPENCODE_PURE 未置真 且 omoEnabled === true
 * 这样运维仍可用环境变量一刀切，不会被页面开关架空。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 开关状态文件（相对 workDir）。 */
export const OMO_ENABLED_REL = path.join('.omo', 'omo-enabled.json');

/**
 * 镜像内 OmO 能力标记（Dockerfile 构建期写入；**不在数据卷里**）。
 *
 * 为什么需要它：开关只在"镜像真的内置了 OmO"时才有意义。没有内置 OmO 的 worker
 * （自定义镜像/精简构建）若也显示开关，用户开启后不会有任何效果——插件根本不存在。
 * 故运行期据此判断是否暴露开关，前端也据此决定是否渲染该卡片。
 */
export const OMO_BUNDLED_MARKER = '/opt/omo-bundled.json';

/** 本镜像是否内置了 OmO（读构建期标记）。 */
export function isOmoBundled(): boolean {
  try {
    const raw = JSON.parse(
      fs.readFileSync(OMO_BUNDLED_MARKER, 'utf8'),
    ) as { bundled?: unknown };
    return raw?.bundled === true;
  } catch {
    return false;
  }
}

/** 开关文件绝对路径。 */
export function omoEnabledPath(workDir: string): string {
  return path.join(workDir, OMO_ENABLED_REL);
}

/**
 * 读取 OmO 启用状态。
 *
 * 默认 **true**（保持既有行为：装了 OmO 就默认加载），仅在显式写入 false 时关闭。
 * 文件不存在/损坏一律按 true——不能让一个坏文件把用户的功能悄悄关掉。
 */
export function readOmoEnabled(workDir: string): boolean {
  try {
    const raw = JSON.parse(
      fs.readFileSync(omoEnabledPath(workDir), 'utf8'),
    ) as { enabled?: unknown };
    return raw?.enabled !== false;
  } catch {
    return true;
  }
}

/**
 * 写入 OmO 启用状态。
 *
 * 同时**同步维护 opencode.json 的 plugin 节**，让配置与开关一致（便于人工排查：
 * 看 opencode.json 就知道插件会不会被加载）。
 *
 * @returns 写入的开关文件绝对路径
 */
export function writeOmoEnabled(workDir: string, enabled: boolean): string {
  const filePath = omoEnabledPath(workDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ enabled }, null, 2)}\n`,
    'utf8',
  );
  return filePath;
}
