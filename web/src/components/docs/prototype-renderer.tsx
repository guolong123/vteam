"use client";

/**
 * PrototypeRenderer：DSL JSON → React 组件树
 * =============================================================
 * 支持 9 种 section 类型：header/stats/cards/table/list/form/tabs/markdown/nav
 * 未知 type 渲染为占位卡片（不崩溃）
 * 视觉风格对齐现有原型组件（tailwind 类，bg-slate-50/卡片/圆角）
 */
import { useState, type ReactNode } from "react";
import { DocsMarkdown } from "./prd-markdown";

/* ---------- DSL 类型定义 ---------- */

interface PrototypeNav {
  label: string;
  active?: boolean;
}

interface SectionHeader {
  type: "header";
  title: string;
  subtitle?: string;
}

interface StatsItem {
  label: string;
  value: string;
  trend?: string;
}

interface SectionStats {
  type: "stats";
  items: StatsItem[];
}

interface CardItem {
  title: string;
  description?: string;
  status?: "success" | "warning" | "danger" | "info";
  badge?: string;
}

interface SectionCards {
  type: "cards";
  items: CardItem[];
}

interface TableColumn {
  key: string;
  label: string;
}

interface SectionTable {
  type: "table";
  columns: TableColumn[];
  rows: Record<string, string>[];
}

interface ListItem {
  title: string;
  description?: string;
}

interface SectionList {
  type: "list";
  items: ListItem[];
}

interface FormField {
  label: string;
  type: "text" | "textarea" | "select";
  options?: string[];
  placeholder?: string;
}

interface SectionForm {
  type: "form";
  fields: FormField[];
  submitLabel?: string;
}

interface TabItem {
  label: string;
  sections: Section[];
}

interface SectionTabs {
  type: "tabs";
  tabs: TabItem[];
}

interface SectionMarkdown {
  type: "markdown";
  content: string;
}

interface SectionNav {
  type: "nav";
  items: PrototypeNav[];
}

type Section =
  | SectionHeader
  | SectionStats
  | SectionCards
  | SectionTable
  | SectionList
  | SectionForm
  | SectionTabs
  | SectionMarkdown
  | SectionNav;

interface Page {
  title: string;
  sections: Section[];
}

export interface Prototype {
  id: string;
  name: string;
  description?: string;
  pages: Page[];
}

/* ---------- Section 组件 ---------- */

function HeaderSection({ section }: { section: SectionHeader }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold text-slate-900">{section.title}</h1>
      {section.subtitle && (
        <p className="mt-1 text-sm text-slate-500">{section.subtitle}</p>
      )}
    </div>
  );
}

function StatsSection({ section }: { section: SectionStats }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
      {section.items.map((item, idx) => (
        <div
          key={idx}
          className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel"
        >
          <p className="text-2xl font-semibold tracking-tight text-slate-900">
            {item.value}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">{item.label}</p>
          {item.trend && (
            <p className="mt-1 text-[11px] font-medium text-slate-400">
              {item.trend}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function CardsSection({ section }: { section: SectionCards }) {
  const statusColors = {
    success: "bg-success-50 text-success-700",
    warning: "bg-warning-50 text-warning-700",
    danger: "bg-danger-50 text-danger-700",
    info: "bg-info-50 text-info-700",
  };

  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {section.items.map((item, idx) => (
        <div
          key={idx}
          className="rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel"
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
            {item.badge && (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  statusColors[item.status ?? "info"]
                }`}
              >
                {item.badge}
              </span>
            )}
          </div>
          {item.description && (
            <p className="text-sm text-slate-500">{item.description}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function TableSection({ section }: { section: SectionTable }) {
  return (
    <div className="mb-6 overflow-x-auto rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            {section.columns.map((col) => (
              <th
                key={col.key}
                className="px-4 py-2.5 font-medium text-slate-600"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.rows.map((row, idx) => (
            <tr key={idx} className="border-b border-slate-100 last:border-0">
              {section.columns.map((col) => (
                <td key={col.key} className="px-4 py-2.5 text-slate-700">
                  {row[col.key] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListSection({ section }: { section: SectionList }) {
  return (
    <div className="mb-6 rounded-[--radius-card] border border-slate-200 bg-white shadow-panel">
      <ul className="divide-y divide-slate-100">
        {section.items.map((item, idx) => (
          <li key={idx} className="px-4 py-3">
            <p className="text-sm font-medium text-slate-900">{item.title}</p>
            {item.description && (
              <p className="mt-0.5 text-xs text-slate-500">{item.description}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FormSection({ section }: { section: SectionForm }) {
  const [formData, setFormData] = useState<Record<string, string>>({});

  return (
    <div className="mb-6 rounded-[--radius-card] border border-slate-200 bg-white p-4 shadow-panel">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // 轻交互：仅客户端状态，无服务端写操作
        }}
      >
        <div className="space-y-4">
          {section.fields.map((field, idx) => (
            <div key={idx}>
              <label className="mb-1 block text-sm font-medium text-slate-700">
                {field.label}
              </label>
              {field.type === "text" && (
                <input
                  type="text"
                  placeholder={field.placeholder}
                  value={formData[field.label] ?? ""}
                  onChange={(e) =>
                    setFormData({ ...formData, [field.label]: e.target.value })
                  }
                  className="w-full rounded-[--radius-control] border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              )}
              {field.type === "textarea" && (
                <textarea
                  placeholder={field.placeholder}
                  value={formData[field.label] ?? ""}
                  onChange={(e) =>
                    setFormData({ ...formData, [field.label]: e.target.value })
                  }
                  className="w-full rounded-[--radius-control] border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  rows={3}
                />
              )}
              {field.type === "select" && (
                <select
                  value={formData[field.label] ?? ""}
                  onChange={(e) =>
                    setFormData({ ...formData, [field.label]: e.target.value })
                  }
                  className="w-full rounded-[--radius-control] border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="">{field.placeholder ?? "请选择"}</option>
                  {field.options?.map((opt, i) => (
                    <option key={i} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
        <button
          type="submit"
          className="mt-4 rounded-[--radius-control] bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
        >
          {section.submitLabel ?? "提交"}
        </button>
      </form>
    </div>
  );
}

function TabsSection({ section }: { section: SectionTabs }) {
  const [activeTab, setActiveTab] = useState(0);

  return (
    <div className="mb-6">
      <div className="mb-4 flex border-b border-slate-200">
        {section.tabs.map((tab, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => setActiveTab(idx)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === idx
                ? "border-b-2 border-brand-500 text-brand-600"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div>
        <SectionRenderer sections={section.tabs[activeTab]?.sections ?? []} />
      </div>
    </div>
  );
}

function MarkdownSection({ section }: { section: SectionMarkdown }) {
  return (
    <div className="mb-6">
      <DocsMarkdown markdown={section.content} />
    </div>
  );
}

function NavSection({ section }: { section: SectionNav }) {
  return (
    <div className="mb-6 flex gap-2">
      {section.items.map((item, idx) => (
        <span
          key={idx}
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
            item.active
              ? "bg-brand-50 text-brand-700"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          {item.label}
        </span>
      ))}
    </div>
  );
}

/* ---------- 未知类型占位 ---------- */

function UnknownSection({ type }: { type: string }) {
  return (
    <div className="mb-6 rounded-[--radius-card] border border-dashed border-slate-300 bg-slate-50 p-4 text-center">
      <p className="text-sm text-slate-500">未支持的组件: {type}</p>
    </div>
  );
}

/* ---------- Section 渲染器 ---------- */

function SectionRenderer({ sections }: { sections: Section[] }) {
  if (!sections || sections.length === 0) {
    return null;
  }

  return (
    <>
      {sections.map((section, idx) => {
        switch (section.type) {
          case "header":
            return <HeaderSection key={idx} section={section} />;
          case "stats":
            return <StatsSection key={idx} section={section} />;
          case "cards":
            return <CardsSection key={idx} section={section} />;
          case "table":
            return <TableSection key={idx} section={section} />;
          case "list":
            return <ListSection key={idx} section={section} />;
          case "form":
            return <FormSection key={idx} section={section} />;
          case "tabs":
            return <TabsSection key={idx} section={section} />;
          case "markdown":
            return <MarkdownSection key={idx} section={section} />;
          case "nav":
            return <NavSection key={idx} section={section} />;
          default:
            return <UnknownSection key={idx} type={(section as { type: string }).type} />;
        }
      })}
    </>
  );
}

/* ---------- 主组件 ---------- */

export function PrototypeRenderer({ prototype }: { prototype: Prototype }) {
  const [activePage, setActivePage] = useState(0);

  if (!prototype.pages || prototype.pages.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-400">
        该原型暂无页面内容
      </div>
    );
  }

  return (
    <div className="min-h-full bg-slate-50 p-4 sm:p-6">
      {/* 原型标题 */}
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-900">{prototype.name}</h2>
        {prototype.description && (
          <p className="mt-0.5 text-sm text-slate-500">{prototype.description}</p>
        )}
      </div>

      {/* 多页切换（仅当有多个 page 时显示） */}
      {prototype.pages.length > 1 && (
        <div className="mb-4 flex gap-2">
          {prototype.pages.map((page, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setActivePage(idx)}
              className={`rounded-[--radius-control] px-3 py-1.5 text-sm font-medium transition-colors ${
                activePage === idx
                  ? "bg-brand-600 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-100"
              }`}
            >
              {page.title}
            </button>
          ))}
        </div>
      )}

      {/* 当前页内容 */}
      <SectionRenderer sections={prototype.pages[activePage]?.sections ?? []} />
    </div>
  );
}
