import { useState } from "react";
import type { PrototypeRenderProps } from "../types";
import { Button, IconEdit, IconPlus, IconSearch, StatusBadge, type Tone } from "../_shared/ui";

/**
 * Skills（技能）管理页原型（组：生态）
 * =====================================================
 * PC：左侧分类筛选（带数量）+ 右侧 Skill 列表卡片；
 * 移动端：分类切换为横向 pills，列表卡片单列。
 * 纯 UI 原型：搜索 / 分类 / 发布状态切换为本地交互。
 */

type SkillType = "prompt" | "tool" | "template";

interface Skill {
  id: string;
  name: string;
  icon: string;
  desc: string;
  type: SkillType;
  version: string;
  agents: number;
  updated: string;
  published: boolean;
}

const SKILLS: Skill[] = [
  {
    id: "sk-001",
    name: "需求文档生成",
    icon: "📝",
    desc: "将需求要点扩写为结构化需求文档，输出背景、目标、验收标准与开放问题。",
    type: "prompt",
    version: "v2.1.0",
    agents: 3,
    updated: "2026-07-30",
    published: true,
  },
  {
    id: "sk-002",
    name: "测试用例生成",
    icon: "🧪",
    desc: "依据功能描述生成等价类、边界值与异常路径测试用例，覆盖度打分。",
    type: "prompt",
    version: "v1.4.0",
    agents: 2,
    updated: "2026-07-26",
    published: true,
  },
  {
    id: "sk-003",
    name: "代码评审标准",
    icon: "🔍",
    desc: "按可维护性、安全性与性能维度执行代码评审，输出分级问题清单。",
    type: "prompt",
    version: "v3.0.0",
    agents: 5,
    updated: "2026-07-21",
    published: true,
  },
  {
    id: "sk-004",
    name: "架构设计模板",
    icon: "🏛️",
    desc: "引导产出系统架构方案，覆盖模块划分、依赖关系、数据流与演进路径。",
    type: "template",
    version: "v1.0.0",
    agents: 1,
    updated: "2026-07-15",
    published: false,
  },
  {
    id: "sk-005",
    name: "GitHub 操作技能包",
    icon: "🐙",
    desc: "绑定 GitHub 插件：创建 PR、评论、合并与读取仓库状态，封装常用组合操作。",
    type: "tool",
    version: "v1.2.0",
    agents: 4,
    updated: "2026-07-28",
    published: true,
  },
  {
    id: "sk-006",
    name: "MCP 工具发现",
    icon: "🔌",
    desc: "绑定 MCP 连接器：自动发现已接入工具服务器并生成调用说明书。",
    type: "tool",
    version: "v0.9.0",
    agents: 2,
    updated: "2026-07-12",
    published: true,
  },
  {
    id: "sk-007",
    name: "发布检查清单",
    icon: "🚀",
    desc: "发布前逐项核验：测试通过、变更说明、回滚方案与监控告警就绪。",
    type: "prompt",
    version: "v1.1.0",
    agents: 0,
    updated: "2026-07-08",
    published: false,
  },
  {
    id: "sk-008",
    name: "数据库巡检技能包",
    icon: "🐘",
    desc: "绑定 PostgreSQL 工具：慢查询分析、连接池水位与表膨胀巡检。",
    type: "tool",
    version: "v2.0.1",
    agents: 2,
    updated: "2026-06-30",
    published: true,
  },
];

const TYPE_META: Record<SkillType, { label: string; tone: Tone }> = {
  prompt: { label: "提示词模板", tone: "info" },
  tool: { label: "工具绑定", tone: "brand" },
  template: { label: "流程模板", tone: "neutral" },
};

type Category = "all" | SkillType;

const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: "all", label: "全部" },
  { value: "prompt", label: "提示词类" },
  { value: "tool", label: "工具绑定类" },
  { value: "template", label: "模板类" },
];

function categoryCount(c: Category) {
  return c === "all" ? SKILLS.length : SKILLS.filter((s) => s.type === c).length;
}

export default function SkillManagePrototype({ device }: PrototypeRenderProps) {
  const mobile = device === "mobile";
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");

  const filtered = SKILLS.filter((s) => {
    const q = query.trim().toLowerCase();
    const matchQ =
      q === "" || s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q);
    const matchC = category === "all" || s.type === category;
    return matchQ && matchC;
  });

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 页头 */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Skills 管理</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            共 {SKILLS.length} 个技能 · 已发布 {SKILLS.filter((s) => s.published).length} 个 ·
            管理 Agent 可复用的提示词模板与工具绑定技能
          </p>
        </div>
        <Button>
          <IconPlus className="size-4" />
          创建 Skill
        </Button>
      </div>

      {/* 搜索框 */}
      <div className="mb-4 flex gap-2.5 rounded-[--radius-card] border border-slate-200 bg-white p-3 shadow-panel">
        <div className={`relative ${mobile ? "w-full" : "w-80"}`}>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索技能名称 / 描述…"
            className="w-full rounded-[--radius-control] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
      </div>

      {/* 布局：PC 左分类 + 右列表 / 移动端 pills + 卡片 */}
      <div className={`gap-4 ${mobile ? "" : "flex items-start"}`}>
        {/* 分类筛选 */}
        {mobile ? (
          <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition-colors ${
                  category === c.value
                    ? "bg-brand-600 font-medium text-white"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {c.label}
                <span className={`ml-1 text-[11px] ${category === c.value ? "text-brand-100" : "text-slate-400"}`}>
                  {categoryCount(c.value)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <aside className="w-48 shrink-0 rounded-[--radius-card] border border-slate-200 bg-white p-2 shadow-panel">
            <p className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-slate-400">分类</p>
            <ul className="space-y-0.5">
              {CATEGORIES.map((c) => (
                <li key={c.value}>
                  <button
                    type="button"
                    onClick={() => setCategory(c.value)}
                    className={`flex w-full items-center justify-between rounded-[--radius-control] px-2.5 py-2 text-sm transition-colors ${
                      category === c.value
                        ? "bg-brand-50 font-medium text-brand-700"
                        : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <span>{c.label}</span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                        category === c.value ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {categoryCount(c.value)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 border-t border-slate-100 px-2.5 py-2 text-[11px] text-slate-400">
              技能可被多个 Agent 引用，发布后对全命名空间生效
            </div>
          </aside>
        )}

        {/* Skill 列表 */}
        <div className={`min-w-0 flex-1 ${mobile ? "" : ""}`}>
          {filtered.length === 0 ? (
            <div className="rounded-[--radius-card] border border-dashed border-slate-300 bg-white/60 px-4 py-12 text-center text-sm text-slate-400">
              没有符合条件的 Skill
            </div>
          ) : (
            <ul className={`grid gap-3 ${mobile ? "grid-cols-1" : "grid-cols-1 xl:grid-cols-2"}`}>
              {filtered.map((s) => (
                <li
                  key={s.id}
                  className="group flex flex-col rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel transition-shadow hover:shadow-frame"
                >
                  <div className="mb-2.5 flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-[--radius-control] bg-slate-50 text-lg ring-1 ring-slate-200">
                        {s.icon}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{s.name}</p>
                        <p className="font-mono text-[11px] text-slate-400">
                          {s.version} · {s.id}
                        </p>
                      </div>
                    </div>
                    <StatusBadge tone={s.published ? "success" : "neutral"}>
                      {s.published ? "已发布" : "草稿"}
                    </StatusBadge>
                  </div>

                  <p className="mb-3 flex-1 text-[13px] leading-relaxed text-slate-500">{s.desc}</p>

                  <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    <StatusBadge tone={TYPE_META[s.type].tone} dot={false}>
                      {TYPE_META[s.type].label}
                    </StatusBadge>
                    <span className="text-[11px] text-slate-400">
                      {s.agents > 0 ? `被 ${s.agents} 个 Agent 使用` : "未被 Agent 引用"}
                    </span>
                    <span className="ml-auto text-[11px] text-slate-400">更新于 {s.updated}</span>
                  </div>

                  <div className="flex gap-2 border-t border-slate-100 pt-3">
                    <Button variant="outline" className="px-2.5 py-1.5 text-xs">
                      <IconEdit className="size-3.5" />
                      编辑
                    </Button>
                    {s.published ? (
                      <Button variant="ghost" className="px-2.5 py-1.5 text-xs">
                        下架
                      </Button>
                    ) : (
                      <Button className="px-2.5 py-1.5 text-xs">发布</Button>
                    )}
                    <Button variant="ghost" className="ml-auto px-2.5 py-1.5 text-xs text-danger-600 hover:bg-danger-50">
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
