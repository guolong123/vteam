import { EmptyState } from "@/src/components/ui";

/**
 * 技能与工具页占位（Task 14 实现技能库与工具注册）。
 */
export default function SkillsPage() {
  return (
    <EmptyState
      title="技能与工具"
      description="管理技能库与工具注册（Task 14 实现）"
      icon={<span>◫</span>}
    />
  );
}