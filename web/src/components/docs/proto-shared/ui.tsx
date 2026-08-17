import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * 原型页面共享 UI 小组件
 * =====================================================
 * 供 src/prototypes/<name>/ 下的原型页面复用：
 *  - StatusBadge：语义色状态徽标（success/warning/danger/info/neutral/brand）
 *  - ProgressBar：进度条
 *  - Avatar：取姓名首字符的圆形头像
 *  - Button：主 / 次 / 危险按钮
 *  - 常用内联图标
 * 全部基于 index.css 中的设计 token（Tailwind 工具类），无第三方依赖。
 */

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

const toneClass: Record<Tone, string> = {
  success: "bg-success-50 text-success-700 ring-success-600/20",
  warning: "bg-warning-50 text-warning-700 ring-warning-500/25",
  danger: "bg-danger-50 text-danger-700 ring-danger-500/20",
  info: "bg-info-50 text-info-700 ring-info-500/20",
  neutral: "bg-slate-100 text-slate-600 ring-slate-500/15",
  brand: "bg-brand-50 text-brand-700 ring-brand-500/25",
};

const dotClass: Record<Tone, string> = {
  success: "bg-success-500",
  warning: "bg-warning-500",
  danger: "bg-danger-500",
  info: "bg-info-500",
  neutral: "bg-slate-400",
  brand: "bg-brand-500",
};

export function StatusBadge({
  tone = "neutral",
  dot = true,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${toneClass[tone]}`}
    >
      {dot && <span className={`size-1.5 rounded-full ${dotClass[tone]}`} />}
      {children}
    </span>
  );
}

export function ProgressBar({
  value,
  tone = "brand",
}: {
  value: number;
  tone?: "brand" | "success" | "warning" | "danger";
}) {
  const barClass = {
    brand: "bg-brand-500",
    success: "bg-success-500",
    warning: "bg-warning-500",
    danger: "bg-danger-500",
  }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div
        className={`h-full rounded-full ${barClass} transition-all`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

const avatarPalette = [
  "bg-brand-100 text-brand-700",
  "bg-info-100 text-info-700",
  "bg-success-100 text-success-700",
  "bg-warning-100 text-warning-700",
  "bg-danger-100 text-danger-700",
  "bg-slate-200 text-slate-700",
];

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const idx = [...name].reduce((acc, ch) => acc + (ch.codePointAt(0) ?? 0), 0) % avatarPalette.length;
  const sizeClass = size === "sm" ? "size-6 text-xs" : "size-8 text-sm";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-medium ${sizeClass} ${avatarPalette[idx]}`}
    >
      {[...name][0] ?? "?"}
    </span>
  );
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: {
  variant?: "primary" | "outline" | "danger" | "ghost";
  className?: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-[--radius-control] px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50";
  const variantClass = {
    primary: "bg-brand-600 text-white hover:bg-brand-700",
    outline: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
    danger: "bg-danger-500 text-white hover:bg-danger-600",
    ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  }[variant];
  return (
    <button className={`${base} ${variantClass} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/* ---------- 内联图标（stroke 风格，currentColor） ---------- */

function Icon({ className = "size-4", children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconSearch = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Icon>
);

export const IconPlus = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconEdit = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </Icon>
);

export const IconMore = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconChevronLeft = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);

export const IconChevronRight = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const IconLock = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect width="18" height="11" x="3" y="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Icon>
);

export const IconClock = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const IconMonitor = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect width="18" height="13" x="3" y="4" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Icon>
);

export const IconSmartphone = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect width="13" height="20" x="5.5" y="2" rx="3" />
    <path d="M12 18h.01" />
  </Icon>
);

export const IconRefresh = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </Icon>
);

export const IconUser = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Icon>
);
