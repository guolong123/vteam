/**
 * 性格（persona）预设单一来源
 * =============================================
 * 对齐 server `src/agents/persona.constants.ts` 的 PERSONA_LIBRARY：
 * key → 中文名 + 预览文案。成员库「编辑成员」面板的「性格配置」下拉与预览框
 * 都从这里取，避免多处复制文案后漂移。
 *
 * 说明：Agent 级性格已从 Agent 配置 UI 移除（存量 Agent.persona 仅作后端回退），
 * 性格现在按成员配置（Member.persona），同一 Agent/岗位的不同成员可有不同风格。
 */

export interface PersonaOption {
  /** PERSONA_LIBRARY key；null = 未配置（后端存 null） */
  key: string | null;
  label: string;
  /** 选中后在面板灰框中展示的行为预览文案（未配置为空串） */
  preview: string;
}

/** 性格 key → 中文名 + 预览文案（对齐 server persona.constants.ts PERSONA_LIBRARY）。 */
export const PERSONA_OPTIONS = [
  { key: null, label: "未配置", preview: "" },
  { key: "steady", label: "沉稳", preview: "先复核信息再下结论，不确定时明确标注置信度，不贸然承诺超出把握的事项。" },
  { key: "strict", label: "苛刻", preview: "以高标准验收，主动挑出真实问题（只拦实质问题，不纠缠表达风格）；每条批评须附改进建议。" },
  { key: "aggressive", label: "激进", preview: "以快速推进为先，先跑通主路径再逐步优化；关键步骤仍保留验证，不跳过验收环节。" },
  { key: "conservative", label: "保守", preview: "稳扎稳打，优先复用既有模式与已验证方案；做出变更前先说明影响与风险。" },
  { key: "innovative", label: "创新", preview: "乐于探索新路径，主动提出替代方案；提出新方案时必须说明其权衡（收益/成本/风险）。" },
] as const satisfies readonly PersonaOption[];

/** 按 key 取性格预览文案；未配置/未知 key 返回空串。 */
export function personaPreview(key: string | null | undefined): string {
  if (!key) return "";
  return PERSONA_OPTIONS.find((option) => option.key === key)?.preview ?? "";
}
