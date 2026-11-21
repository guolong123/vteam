/**
 * UpgradeCommandDialog：**手动升级指引**弹窗（复制命令让用户自己执行）
 * =====================================================================
 * 场景：节点**不能自己升级**——Windows 缺省关闭自更新（无自动回滚）、旧版本 worker
 * 没有重启桥、或 Linux 无 systemd。这些节点点「更新」按钮只会落 `ready-manual`
 * 然后什么也不发生（静默失败），所以改为给一条**可复制执行的命令**。
 *
 * 对齐项目既有 Modal 模式（confirm-dialog / reject-modal）：
 * - absolute 相对宿主（宿主需 position:relative）+ 遮罩点击关闭 + Esc 关闭；
 * - 无 fixed / 100vh / 100vw（铁律 T15）。
 *
 * 复制实现：`navigator.clipboard.writeText`，失败时降级为「选中文本」让用户手动复制
 * （内网 http 非 localhost 时 Clipboard API 不可用，是本仓库既有踩坑）。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  neutral,
  surface,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import { useFocusTrap } from "@/hooks/use-focus-trap";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface UpgradeCommandDialogProps {
  open: boolean;
  /** 节点标识（标题里展示，让用户确认是哪台机器）。 */
  workerLabel: string;
  /** 一句话说明：在哪台机器上怎么执行。 */
  summary: string;
  /** 可复制命令；空串 = 认不出安装方式（只给文字说明，不展示复制按钮）。 */
  command: string;
  /** 为什么不能一键升级（解释，避免用户以为按钮坏了）。 */
  reason?: string;
  /**
   * 命令里填的控制面地址（由调用方按当前访问 origin 推导）。
   *
   * 为什么由调用方传而不是组件内算：地址推导规则与安装页共享
   * （`deriveServerBase`，web 13001→server 13000），放组件里会再造一份口径。
   */
  serverBase?: string;
  /**
   * 静态资源基址（install-worker.ps1 / worker-src.tar.gz 由 **web** 提供）。
   *
   * ⚠️ 与 `serverBase` 必须分开：compose 默认 web=13001、server=13000，
   * 用同一个地址会让命令去 server 端口取脚本 ⇒ **404**（线上事故）。
   */
  webBase?: string;
  /** 地址是否回环（127.0.0.1/localhost）——是则提示"远程节点需换成局域网 IP"。 */
  loopback?: boolean;
  onClose: () => void;
}

export function UpgradeCommandDialog({
  open,
  workerLabel,
  summary,
  command,
  reason,
  serverBase,
  webBase,
  loopback = false,
  onClose,
}: UpgradeCommandDialogProps) {
  /* 焦点**不**落在第一个 input（地址框）上：那会让 Ctrl+C 复制 input 自身选区，
     用户选中的命令文本复制不到（实测"没法复制"）。优先聚焦「复制命令」主操作。 */
  const dialogRef = useFocusTrap<HTMLDivElement>(
    open,
    onClose,
    '[data-testid="worker-upgrade-copy"]',
  );
  const codeRef = useRef<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);
  /** 复制失败（Clipboard 不可用）→ 转为提示用户手动选中。 */
  const [copyFailed, setCopyFailed] = useState(false);

  /**
   * 命令里的控制面地址：可编辑。
   *
   * 为什么允许改：地址由「当前访问 origin」推导，但命令要在 **worker 主机**上跑。
   * 用户在控制面本机用 `127.0.0.1` 打开时，推导出的回环地址对**远程** worker 无效
   * （那台机器上 127.0.0.1 是它自己）。控制面在局域网里的 IP 无法从浏览器得知，
   * 只能让用户填——但**缺省值永远是当前访问地址**，不是硬编码回环。
   */
  const [editableBase, setEditableBase] = useState(serverBase ?? "");
  const [editableWeb, setEditableWeb] = useState(webBase ?? "");

  // 每次打开重置复制态（否则第二次打开还显示"已复制"）
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setCopyFailed(false);
    setEditableBase(serverBase ?? "");
    setEditableWeb(webBase ?? "");
  }, [open, command, serverBase, webBase]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  /* 真实命令：把模板里的 {{SERVER_URL}} 换成用户确认过的地址。 */
  const effectiveCommand = command
    .replaceAll("{{SERVER_URL}}", editableBase.trim().replace(/\/$/, ""))
    .replaceAll("{{WEB_URL}}", editableWeb.trim().replace(/\/$/, ""));

  const handleCopy = async () => {
    if (effectiveCommand === "") return;

    // ① 现代 Clipboard API（**需要安全上下文**：https 或 localhost）
    //    ⚠️ 内网 http 下 `navigator.clipboard` 往往是 undefined（不是"调用失败"），
    //    直接 await 它的方法会抛 TypeError ⇒ 必须先判存在。
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(effectiveCommand);
        setCopied(true);
        setCopyFailed(false);
        return;
      } catch {
        // 权限被拒 / 非安全上下文 ⇒ 继续走兜底
      }
    }

    // ② 兜底：`document.execCommand('copy')`（已废弃，但**在 http 下仍然可用**，
    //    这正是内网部署的关键路径）。需要临时把文本放进一个可选中元素。
    let copied = false;
    try {
      const ta = document.createElement("textarea");
      ta.value = effectiveCommand;
      // 移出视口但保留可选中性（display:none 会让 execCommand 失效）
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      copied = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      copied = false;
    }
    if (copied) {
      setCopied(true);
      setCopyFailed(false);
      return;
    }

    // ③ 最后兜底：选中命令文本让用户手动 Ctrl+C。
    //    这条路径下**必须把焦点移出输入框**，否则 Ctrl+C 复制的是 input 自身选区
    //    （用户实测"没法复制"的根因之一）。
    setCopyFailed(true);
    const el = codeRef.current;
    if (el && typeof window !== "undefined") {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      // 让 Ctrl+C 作用于这段选区：把焦点交给可聚焦的 pre 容器
      const focusTarget = el.parentElement;
      if (focusTarget !== null) {
        focusTarget.setAttribute("tabindex", "-1");
        focusTarget.focus({ preventScroll: true });
      }
    }
  };

  return (
    <div
      data-testid="worker-upgrade-modal"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(15,23,42,0.45)",
        padding: space.md,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="worker-upgrade-title"
        style={{
          ...baseFont,
          width: "100%",
          maxWidth: 640,
          backgroundColor: surface,
          borderRadius: radius.lg,
          boxShadow: shadow.lg,
          padding: space.lg,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <h2
            id="worker-upgrade-title"
            style={{ margin: 0, fontSize: fontSize.lg, fontWeight: 700, color: neutral[800] }}
          >
            手动升级 Worker
          </h2>
          <div style={{ fontSize: fontSize.sm, color: neutral[500] }}>
            节点 <span style={{ fontFamily: fontFamily.mono, fontWeight: 600 }}>{workerLabel}</span>
            　不能自动升级
          </div>
        </div>

        {/* 为什么不能一键升级（先解释，再给操作 —— 用户第一反应是"按钮是不是坏了"） */}
        {reason !== undefined && reason !== "" && (
          <div
            data-testid="worker-upgrade-reason"
            style={{
              fontSize: fontSize.sm,
              color: "var(--color-warning-text)",
              backgroundColor: "var(--color-warning-bg)",
              border: "1px solid var(--color-warning-border)",
              borderRadius: radius.md,
              padding: space.sm,
              lineHeight: 1.6,
            }}
          >
            {reason}
          </div>
        )}

        <div style={{ fontSize: fontSize.sm, color: neutral[600], lineHeight: 1.6 }}>
          {summary}
        </div>

        {/* 控制面地址：缺省 = 当前访问地址（由调用方推导），可改成 worker 能访问到的地址。
            回环地址在远程 worker 上指向它自己 ⇒ 必须显式警示。 */}
        {command !== "" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label
              htmlFor="worker-upgrade-base"
              style={{ fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}
            >
              控制面地址（worker 需能访问）
            </label>
            <input
              id="worker-upgrade-base"
              data-testid="worker-upgrade-base-input"
              value={editableBase}
              onChange={(e) => {
                setEditableBase(e.target.value);
                setCopied(false);
              }}
              spellCheck={false}
              style={{
                ...baseFont,
                padding: `${space.xs}px ${space.sm}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: surface,
                color: neutral[800],
                fontSize: fontSize.sm,
                fontFamily: fontFamily.mono,
              }}
            />
            {/* 静态资源地址：仅当命令里用到脚本/tarball 时才显示。
                compose 下它与 API 地址**不同**（web 13001 / server 13000）——
                早先混用导致 `Cannot GET /install-worker.ps1` 404。 */}
            {webBase !== undefined && editableWeb !== editableBase && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label
                  htmlFor="worker-upgrade-web"
                  style={{ fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}
                >
                  安装脚本地址（worker 需能访问；与上面的 API 地址不同端口）
                </label>
                <input
                  id="worker-upgrade-web"
                  data-testid="worker-upgrade-web-input"
                  value={editableWeb}
                  onChange={(e) => {
                    setEditableWeb(e.target.value);
                    setCopied(false);
                  }}
                  spellCheck={false}
                  style={{
                    ...baseFont,
                    padding: `${space.xs}px ${space.sm}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: surface,
                    color: neutral[800],
                    fontSize: fontSize.sm,
                    fontFamily: fontFamily.mono,
                  }}
                />
              </div>
            )}
            {loopback && (
              <div
                data-testid="worker-upgrade-loopback-warning"
                style={{
                  fontSize: fontSize.xs,
                  color: "var(--color-warning-text)",
                  backgroundColor: "var(--color-warning-bg)",
                  border: "1px solid var(--color-warning-border)",
                  borderRadius: radius.sm,
                  padding: `${space.xs}px ${space.sm}px`,
                  lineHeight: 1.6,
                }}
              >
                ⚠️ 当前是回环地址（127.0.0.1/localhost）。命令要在 worker 主机上执行，
                那里的 127.0.0.1 指向它自己 ⇒ 请改成控制面的局域网 IP（或从局域网地址打开本页后重新复制）。
              </div>
            )}
          </div>
        )}

        {command !== "" ? (
          <>
            <pre
              onMouseDown={(e) => {
                // 防止 mousedown 把焦点抢到 pre 上后再被 trap 拉回（保持选区可用）
                e.preventDefault();
              }}
              style={{
                margin: 0,
                userSelect: "text",
                cursor: "text",
                padding: space.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.md,
                fontSize: fontSize.xs,
                fontFamily: fontFamily.mono,
                color: neutral[800],
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                lineHeight: 1.6,
              }}
            >
              <code ref={codeRef} data-testid="worker-upgrade-command">
                {effectiveCommand}
              </code>
            </pre>
            {copyFailed && (
              <div style={{ fontSize: fontSize.xs, color: "var(--color-warning-text)" }}>
                浏览器不允许自动复制（内网 http 常见）——命令已选中，请按 Ctrl+C / ⌘C 复制。
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: fontSize.sm, color: neutral[600], lineHeight: 1.6 }}>
            未识别出该节点的安装方式，因此无法给出确切命令。请重跑该节点原来的安装脚本：
            Linux 用 <code style={{ fontFamily: fontFamily.mono }}>install-worker.sh</code>，
            Windows 用{' '}
            <code style={{ fontFamily: fontFamily.mono }}>install-worker.ps1 -Force</code>。
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button
            type="button"
            data-testid="worker-upgrade-close"
            onClick={onClose}
            style={{
              ...baseFont,
              padding: `${space.sm - 1}px ${space.md}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: surface,
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: "pointer",
            }}
          >
            关闭
          </button>
          {command !== "" && (
            <button
              type="button"
              data-testid="worker-upgrade-copy"
              onClick={() => void handleCopy()}
              style={{
                ...baseFont,
                padding: `${space.sm - 1}px ${space.md}px`,
                borderRadius: radius.md,
                border: `1px solid ${
                  copied ? "var(--color-role-developer-border)" : "var(--color-warning-border)"
                }`,
                backgroundColor: copied
                  ? "var(--color-role-developer-bg)"
                  : "var(--color-warning-bg)",
                color: copied ? "var(--color-role-developer-color)" : "var(--color-warning-text)",
                fontSize: fontSize.md,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {copied ? "已复制" : "复制命令"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
