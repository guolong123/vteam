"use client";

/**
 * AppShell：全局应用外壳（client 组合层）
 * =============================================
 * 组合 NavTopBar（顶栏）+ NavDock（左缘 Dock 悬浮导航）+ CmdKPanel（命令面板）：
 * - 顶栏常驻，内容区左缘留白避开 Dock（RAIL_W + 24）
 * - Dock 高亮跟随当前路由（pathname 首段 ↔ NAV_ITEMS.key）
 * - Cmd+K / Ctrl+K 快捷键与顶栏触发框唤起命令面板（useState 受控）
 * - 命令面板「导航」组选择 → 路由跳转；Esc / 遮罩 / ✕ 关闭
 * - 登录守卫：未登录（authStore.token 为空）跳转 /login
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/authStore";
import { neutral, radius, fontSize, fontFamily } from "@/src/theme/tokens";
import { NavDock, NavTopBar, CmdKPanel, NAV_ITEMS, DEFAULT_CMDK_ITEMS } from "./index";
import type { CmdKItem } from "./index";
import { hasPermission, isPlatformAdmin, type RolePermissions } from "@/lib/permissions";
import {
  useCanvasUIStore,
  type CanvasUIEffectKey,
} from "@/src/components/canvasui/store";

/**
 * 演示模式开关（UX-04）：页面效果下拉默认隐藏，仅当 URL ?fx=on 或
 * localStorage 键值开启演示模式时显示；CanvasUI 效果应用逻辑不变。
 */
const FX_DEMO_STORAGE_KEY = "canvasui.demo-mode";

/** 全局 Canvas UI 效果下拉分组（与 store 的效果键对应）。 */
const CANVASUI_GROUPS: {
  label: string;
  items: { key: CanvasUIEffectKey; label: string }[];
}[] = [
  {
    label: "光学与玻璃",
    items: [
      { key: "glass", label: "玻璃球" },
      { key: "frost", label: "霜冻" },
      { key: "magnify", label: "放大镜" },
      { key: "bend", label: "弯曲" },
      { key: "peel", label: "剥落" },
      { key: "bubble", label: "气泡" },
      { key: "displacement", label: "位移" },
    ],
  },
  {
    label: "流体与天气",
    items: [
      { key: "droplets", label: "雨滴" },
      { key: "liquid", label: "流体" },
      { key: "ripple", label: "涟漪" },
      { key: "cloth", label: "布料" },
      { key: "clouds", label: "云层" },
    ],
  },
  {
    label: "火与能量",
    items: [
      { key: "blaze", label: "火焰" },
      { key: "flamewrap", label: "火焰环绕" },
      { key: "forcefield", label: "力场" },
      { key: "laser", label: "激光" },
    ],
  },
  {
    label: "复古与特效",
    items: [
      { key: "glitch", label: "故障" },
      { key: "vhs", label: "磁带" },
      { key: "retrodither", label: "复古点阵" },
      { key: "asciify", label: "字符化" },
      { key: "decryptreveal", label: "解密揭示" },
      { key: "glyphrain", label: "字符雨" },
    ],
  },
  {
    label: "粒子与结构",
    items: [
      { key: "canvas", label: "画布" },
      { key: "particlereveal", label: "粒子揭示" },
      { key: "particlescroll", label: "粒子滚动" },
      { key: "shatter", label: "碎裂" },
      { key: "grid", label: "网格" },
      { key: "hexfloat", label: "六边形" },
    ],
  },
];

const baseFont = { fontFamily: fontFamily.body } as const;

/** Dock 收起宽度（对齐 nav-dock.tsx RAIL_W） */
const RAIL_W = 56;
/** 内容区左缘留白：Dock 宽度 + 呼吸间距（对齐 nav-rail / nav-hybrid 原型） */
const CONTENT_LEFT_PAD = RAIL_W + 24;

/** 导航 key → 路由路径（与 NAV_ITEMS 对齐） */
const KEY_TO_PATH: Record<string, string> = {
  project: "/projects",
  agents: "/agents",
  workers: "/workers",
  models: "/models",
  skills: "/skills",
  messages: "/messages",
  users: "/users",
  roles: "/roles",
};

/** 路由路径 → 导航 key（pathname 首段） */
function pathToKey(pathname: string): string {
  const seg = pathname.split("/")[1] ?? "";
  return KEY_LOOKUP[seg] ?? "";
}

/** 反向查找：路径段 → key */
const KEY_LOOKUP: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(KEY_TO_PATH).map(([key, path]) => [path.slice(1), key])
  ),
  /** Dock 无独立 board/tasks 图标：任务与项目为父子层级，任务相关路由
   * （/board、/tasks/:id、/tasks/new、/artifacts）均高亮「项目」入口 */
  board: "project",
  tasks: "project",
  artifacts: "project",
};

/** 非导航页（无 Dock key）的标题兜底：全路径 → 页面标题 */
const EXTRA_PAGE_TITLE: Record<string, { title: string; subtitle: string }> = {
  "/tasks/new": { title: "创建任务", subtitle: "提交需求，组建虚拟 AI 团队" },
  "/tasks/[id]": { title: "任务群聊", subtitle: "与任务团队实时协作" },
  "/messages/[id]": { title: "私聊", subtitle: "与 Agent 一对一对话" },
  "/workers/[id]": { title: "Worker 详情", subtitle: "查看节点能力与运行状态" },
  "/tools/register": { title: "注册工具", subtitle: "登记工具 manifest 并绑定执行方式" },
};

/** 命令面板「导航」组 label → 路由路径 */
const CMDK_NAV_PATH: Record<string, string> = {
  切换项目: "/projects",
  "Agent 管理": "/agents",
  "Worker 节点": "/workers",
  模型管理: "/models",
  技能与工具: "/skills",
  消息中心: "/messages",
  用户管理: "/users",
  角色权限: "/roles",
};

/**
 * 导航 key → 可见性判定（对齐后端守卫语义，ISSUE-005）：
 * - 无条目的 key（project/models/messages）→ 后端无权限点（登录即可 / 成员只读），始终显示；
 * - agents/workers/skills → 矩阵 view 权限点（PermissionGuard）；
 * - users/roles → AdminGuard 语义（all:true 或 users.manage）。
 */
const NAV_VISIBLE: Record<string, (perms: RolePermissions) => boolean> = {
  agents: (p) => hasPermission(p, "agents"),
  workers: (p) => hasPermission(p, "workers"),
  skills: (p) => hasPermission(p, "skills"),
  users: isPlatformAdmin,
  roles: isPlatformAdmin,
};

/** 路由首段 → 访问所需判定（与导航过滤同源；/tools 属 skills 资源；无条目 = 登录即可） */
const ROUTE_GUARD: Record<string, (perms: RolePermissions) => boolean> = {
  ...NAV_VISIBLE,
  tools: (p) => hasPermission(p, "skills"),
};

/** 角色显示名（对齐 users 页 ROLE_LABEL：admin→管理员 / member→成员 / 其余原名） */
const ROLE_LABEL: Record<string, string> = { admin: "管理员", member: "成员" };

function roleLabel(name?: string): string {
  return name ? (ROLE_LABEL[name] ?? name) : "";
}

/** GET /projects/:pid/tasks 分页响应（仅页头计数取 total，pageSize=1 最小化传输）。 */
interface BoardTasksResponse {
  items: unknown[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /workers 条目（页头「Agent 在线」统计仅需 status：在线 = status !== 'offline'）。 */
interface WorkerSummaryRow {
  id: string;
  status: string;
}

/** 页面标题（顶栏左侧，无面包屑时展示；对齐各页原型 NavTopBar） */
const PAGE_TITLE: Record<string, { title: string; subtitle: string }> = {
  project: { title: "项目列表", subtitle: "选择项目进入 AI 协作工作区" },
  board: { title: "任务看板", subtitle: "" },
  agents: { title: "Agent 管理", subtitle: "配置角色、技能与权限" },
  workers: { title: "Worker 节点", subtitle: "查看与管理 Worker 节点" },
  models: { title: "模型管理", subtitle: "模型目录 / Provider 凭证管理" },
  skills: { title: "技能与工具", subtitle: "管理技能库与工具注册" },
  messages: { title: "消息中心", subtitle: "任务群聊与私聊会话" },
  users: { title: "用户管理", subtitle: "管理平台账号与角色分配" },
  roles: { title: "角色权限", subtitle: "管理平台角色与权限矩阵" },
};

/** 动态段路由优先判定：/tasks/:id（非 /tasks/new）→ 任务群聊；/messages/:id → 私聊；/workers/:id → Worker 详情 */
function resolvePageTitle(pathname: string): { title: string; subtitle: string } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "tasks" && parts.length === 2 && parts[1] !== "new") {
    return EXTRA_PAGE_TITLE["/tasks/[id]"];
  }
  if (parts[0] === "messages" && parts.length === 2) {
    return EXTRA_PAGE_TITLE["/messages/[id]"];
  }
  if (parts[0] === "workers" && parts.length === 2) {
    return EXTRA_PAGE_TITLE["/workers/[id]"];
  }
  const exact = EXTRA_PAGE_TITLE[pathname];
  if (exact) return exact;
  // /board 页保留专属标题（Dock key 映射已并入 project，此处按路径先命中）
  if (parts[0] === "board") {
    return PAGE_TITLE.board;
  }
  const key = pathToKey(pathname);
  return PAGE_TITLE[key] ?? { title: "任务看板", subtitle: "" };
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const effect = useCanvasUIStore((s) => s.effect);
  const setEffect = useCanvasUIStore((s) => s.setEffect);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  // UX-04：页面效果下拉默认隐藏，仅演示模式（?fx=on 或 localStorage 开关）显示
  const [fxDemo, setFxDemo] = useState(false);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const urlOn = search.get("fx") === "on";
    const lsOn = window.localStorage.getItem(FX_DEMO_STORAGE_KEY) === "1";
    if (urlOn) window.localStorage.setItem(FX_DEMO_STORAGE_KEY, "1");
    setFxDemo(urlOn || lsOn);
  }, []);

  const activeKey = pathToKey(pathname);
  const page = resolvePageTitle(pathname);

  // zustand persist 水合为异步 Promise 链：渲染时可能尚未完成。
  // 统一在 effect 中订阅，避免 useState 初始化与 hydrate 时序竞争。
  const [hydrated, setHydrated] = useState(false);

  // 登录守卫：确认水合完成且未登录时跳转 /login
  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, []);

  useEffect(() => {
    if (hydrated && !token) {
      router.replace("/login");
    }
  }, [hydrated, token, router]);

  // 权限守卫（ISSUE-005）：无权限路由 → 重定向到首个有权限的导航目标，
  // 不再渲染被禁模块骨架（后端 403 兜底之外的前端第一道闸）。
  useEffect(() => {
    if (!hydrated || !token || !user) return;
    const seg = pathname.split("/")[1] ?? "";
    const check = ROUTE_GUARD[seg];
    if (!check || check(user.permissions)) return;
    const fallback = NAV_ITEMS.find(
      (item) =>
        !NAV_VISIBLE[item.key] || NAV_VISIBLE[item.key](user.permissions),
    )?.key;
    router.replace(fallback ? KEY_TO_PATH[fallback] : "/projects");
  }, [hydrated, token, pathname, user, router]);

  // 导航过滤：受限用户仅显示有权限项；project/models/messages 无后端权限点恒显示
  const visibleItems = useMemo(() => {
    if (!user) return NAV_ITEMS;
    return NAV_ITEMS.filter(
      (item) =>
        !NAV_VISIBLE[item.key] || NAV_VISIBLE[item.key](user.permissions),
    );
  }, [user]);

  // Cmd+K「导航」组过滤：与导航可见性同源，被禁路由不可从命令面板唤起
  const cmdkItems = useMemo<CmdKItem[] | undefined>(() => {
    if (!user) return undefined;
    return DEFAULT_CMDK_ITEMS.filter((item) => {
      if (item.group !== "导航") return true;
      const path = CMDK_NAV_PATH[item.label];
      if (!path) return true;
      const seg = path.split("/")[1] ?? "";
      const check = ROUTE_GUARD[seg];
      return !check || check(user.permissions);
    });
  }, [user]);

  // /board 页头计数（ISSUE-001）：原 PAGE_TITLE.board subtitle 硬编码 mock 值
  // （「5 个任务 · 4 个 Agent 在线」源自原型 mock），改为按 URL ?pid= 动态取数。
  const isBoard = pathname.split("/")[1] === "board";
  const [boardPid, setBoardPid] = useState<string | null>(null);
  useEffect(() => {
    if (pathname.split("/")[1] === "board") {
      setBoardPid(new URLSearchParams(window.location.search).get("pid"));
    } else {
      setBoardPid(null);
    }
  }, [pathname]);

  // 任务总数：GET /projects/:pid/tasks 的 total（与看板页同源，三方对照基准）
  const boardTasks = useQuery({
    queryKey: ["board-tasks", boardPid],
    queryFn: () =>
      api.get<BoardTasksResponse>(`/projects/${boardPid}/tasks`, {
        query: { page: 1, pageSize: 1 },
      }),
    enabled: hydrated && !!token && isBoard && !!boardPid,
  });
  // Agent 在线数：平台在线 worker（status != offline，Agent 无在线态，Worker 为在线源）
  const boardWorkers = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<WorkerSummaryRow[]>("/workers"),
    enabled: hydrated && !!token && isBoard,
  });

  const boardSubtitle = useMemo(() => {
    if (!isBoard) return page.subtitle;
    const total = boardTasks.data?.total;
    const onlineCount = boardWorkers.data?.filter((w) => w.status !== "offline").length;
    if (total === undefined || onlineCount === undefined) return "";
    return `${total} 个任务 · ${onlineCount} 个 Agent 在线`;
  }, [isBoard, page.subtitle, boardTasks.data, boardWorkers.data]);

  // Cmd+K / Ctrl+K 快捷键唤起命令面板
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdkOpen(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const goto = (key: string) => {
    const path = KEY_TO_PATH[key];
    if (path && path !== pathname) router.push(path);
  };

  const handleCmdKSelect = (label: string) => {
    setCmdkOpen(false);
    // 「操作」组快捷命令：新建任务 → task-create 缺省项目（URL ?pid= 优先，缺省 p_seed_1）
    if (label === "新建任务") {
      const target = "/tasks/new?pid=p_seed_1";
      if (target !== pathname) router.push(target);
      return;
    }
    const path = CMDK_NAV_PATH[label];
    if (path && path !== pathname) router.push(path);
  };

  return (
    <div
      data-testid="app-shell"
      style={{ height: "100vh", display: "flex", flexDirection: "column", position: "relative", backgroundColor: neutral[50], ...baseFont }}
    >
      {/* 顶栏（文档流顶部） */}
      <NavTopBar
        title={page.title}
        subtitle={boardSubtitle}
        userName={user?.displayName ?? "运营者"}
        userRole={user ? roleLabel(user.roleName) : undefined}
        onCmdKClick={() => setCmdkOpen(true)}
      >
        {/* 全局效果下拉（头像右侧插槽，与登出按钮并排）— UX-04：仅演示模式显示 */}
        {fxDemo && (
          <select
            data-testid="canvasui-select"
            aria-label="页面效果"
            value={effect}
            onChange={(e) => setEffect(e.target.value as CanvasUIEffectKey)}
            style={{
              maxWidth: 120,
              padding: "6px 8px",
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.sm,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            {CANVASUI_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value="none">关闭</option>
          </select>
        )}
        {/* 登出按钮（头像右侧插槽）：清空认证态并回到登录页 */}
        <button
          type="button"
          data-testid="logout-button"
          aria-label="退出登录"
          onClick={() => {
            logout();
            router.replace("/login");
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "6px 12px",
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "#FFFFFF",
            color: neutral[600],
            fontSize: fontSize.sm,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: fontFamily.body,
            whiteSpace: "nowrap",
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>↪</span>
          退出登录
        </button>
      </NavTopBar>

      {/* 内容区：左缘留白避开 Dock */}
      <div
        data-testid="app-content"
        style={{ flex: 1, minHeight: 0, display: "flex", paddingLeft: CONTENT_LEFT_PAD }}
      >
        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
          {children}
        </main>
      </div>

      {/* 左侧 Dock 悬浮导航条（z-index 50，浮于命令面板遮罩之上） */}
      <NavDock activeKey={activeKey} items={visibleItems} onNavClick={goto} />

      {/* Cmd+K 命令面板（受控开关） */}
      <CmdKPanel
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        onSelect={handleCmdKSelect}
        items={cmdkItems}
      />
    </div>
  );
}