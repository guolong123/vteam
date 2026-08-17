/**
 * proto-shared：Agent 原型共享库统一导出
 * =====================================================
 * 平台内置共享库（web/src/components/docs/proto-shared/），供 agent 原型通过
 * `@proto/shared`（或相对 `../_shared/*`）import。编译链路把别名解析到本目录，
 * 与 md-docs 的 docs/agent-platform/prototypes/_shared 保持一致。
 *
 * 冲突处理：components.tsx（任务状态版 StatusBadge）与 ui.tsx（tone 版 StatusBadge）
 * 同名导出，ui 版在统一导出中重命名为 UiStatusBadge。
 */
export * from "./styles";
export * from "./components";
export * from "./nav";
export * from "./types";

export {
  StatusBadge as UiStatusBadge,
  ProgressBar,
  Avatar,
  Button,
  IconSearch,
  IconPlus,
  IconEdit,
  IconMore,
  IconChevronLeft,
  IconChevronRight,
  IconLock,
  IconClock,
  IconMonitor,
  IconSmartphone,
  IconRefresh,
  IconUser,
} from "./ui";
