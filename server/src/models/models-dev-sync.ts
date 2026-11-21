/**
 * models.dev 模型能力同步（2026-11-18）
 * =====================================
 * 为什么是 models.dev：opencode 官方文档明确说明
 * 「OpenCode lists models from [models.dev](https://models.dev), provider integrations,
 *  and your configuration」——它对不在目录里的模型只会**假设**能力（文档原话：
 * "These are fallback assumptions, not detected capabilities"）。所以 models.dev 就是
 * opencode 生态里模型能力的**权威来源**，我们不该自己猜、也不该让用户逐模型手填。
 *
 * 为什么不能只靠上游 `/models`：
 * - 实测 commandcode 的 `GET /provider/v1/models` **对每个模型返回完全相同的字段**
 *   （只有 id/name/context_length/supported_endpoints），**不含任何能力信息**；
 * - 而 models.dev 对同一批模型给出逐个不同的真实能力：
 *   `deepseek/deepseek-v4.1-flash` → input ["text","image"]
 *   `deepseek/deepseek-v4-pro`     → input ["text"]        ← 同 provider 同族，却不支持图
 *   93 个模型里 73 个支持 image、20 个不支持 —— **能力必须逐模型取，不能按 provider 拉平**。
 *
 * 数据形状（models.dev/api.json）：
 * ```
 * { "<providerID>": { id, api, models: { "<modelID>": {
 *     id, name, attachment, reasoning, reasoning_options,
 *     tool_call, temperature, modalities: { input: [...], output: [...] },
 *     limit: { context, output }, cost: {...}
 * }} } }
 * ```
 * 我们把其中与本平台 `ModelCapabilities` 对齐的部分映射过来（modalities/toolCall/
 * attachment/reasoning/limit），不认识的字段一律忽略（models.dev 会持续加新键）。
 */

/** models.dev 全量目录 URL（官方公开 JSON，约 6.7MB）。 */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** 同步请求超时（目录较大，本机实测 6.7MB / 数秒；给足余量但不无限等）。 */
const MODELS_DEV_TIMEOUT_MS = 30_000;

/**
 * 本平台 `ModelCapabilities` 的子集（server 侧 models.constants 的镜像，
 * 此处按结构化类型收窄，避免与 DTO 循环依赖）。
 */
export interface SyncedModelCapabilities {
  modalities?: { input?: string[]; output?: string[] };
  toolCall?: boolean;
  attachment?: boolean;
  reasoning?: boolean;
  limit?: { context?: number; output?: number };
}

/** models.dev 原始模型条目（只声明我们读的字段，其余忽略）。 */
interface ModelsDevModel {
  id?: unknown;
  name?: unknown;
  attachment?: unknown;
  reasoning?: unknown;
  tool_call?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
}

/** models.dev 原始 provider 条目。 */
interface ModelsDevProvider {
  id?: unknown;
  api?: unknown;
  models?: Record<string, ModelsDevModel>;
}

/** models.dev 全量目录。 */
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/** 合法的模态枚举（与 opencode v2 的 capabilities.input/output 对齐）。 */
const KNOWN_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);

/** 归一模态数组：过滤未知值 + 去重；空数组视为未声明（返回 undefined）。 */
function normalizeModalities(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const m = v.trim().toLowerCase();
    if (!m || !KNOWN_MODALITIES.has(m) || out.includes(m)) continue;
    out.push(m);
  }
  return out.length > 0 ? out : undefined;
}

/** 归一正整数（limit.context / limit.output）。 */
function positiveInt(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * models.dev 模型条目 → 本平台 capabilities。
 *
 * 只输出**确实有值**的字段（缺什么就不写什么）：`undefined` 与「明确不支持」必须区分开
 * —— 例如 models.dev 写 `attachment: false` 是明确事实，而字段缺失是「未知」。
 * 返回 undefined 表示该条目没有任何可用能力信息（调用方跳过、不覆盖库内既有值）。
 */
export function mapModelsDevEntry(
  entry: ModelsDevModel | undefined,
): SyncedModelCapabilities | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const out: SyncedModelCapabilities = {};

  const input = normalizeModalities(entry.modalities?.input);
  const output = normalizeModalities(entry.modalities?.output);
  if (input || output) {
    out.modalities = {
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
    };
  }
  if (typeof entry.tool_call === 'boolean') out.toolCall = entry.tool_call;
  if (typeof entry.attachment === 'boolean') out.attachment = entry.attachment;
  if (typeof entry.reasoning === 'boolean') out.reasoning = entry.reasoning;

  const limitContext = positiveInt(entry.limit?.context);
  const limitOutput = positiveInt(entry.limit?.output);
  if (limitContext || limitOutput) {
    out.limit = {
      ...(limitContext ? { context: limitContext } : {}),
      ...(limitOutput ? { output: limitOutput } : {}),
    };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从全量目录里取出某个 provider 的所有模型能力。
 *
 * provider 匹配：先按 providerID 精确命中；未命中再按 `api` 端点（去掉尾部斜杠）匹配
 * —— 平台里的 providerID 是用户自定义的（如网关别名），但 baseUrl 通常与 models.dev
 * 的 `api` 一致，这给了一条可靠的兜底识别路径。
 */
export function extractProviderCapabilities(
  catalog: ModelsDevCatalog,
  providerID: string,
  baseUrl?: string | null,
): Map<string, SyncedModelCapabilities> {
  const out = new Map<string, SyncedModelCapabilities>();
  if (!catalog || typeof catalog !== 'object') return out;

  let entry = catalog[providerID];
  if (!entry && baseUrl) {
    const target = normalizeApi(baseUrl);
    if (target) {
      for (const candidate of Object.values(catalog)) {
        if (!candidate || typeof candidate !== 'object') continue;
        const api = typeof candidate.api === 'string' ? candidate.api : '';
        if (normalizeApi(api) === target) {
          entry = candidate;
          break;
        }
      }
    }
  }
  if (!entry?.models) return out;

  for (const [modelID, model] of Object.entries(entry.models)) {
    const caps = mapModelsDevEntry(model);
    if (caps) out.set(modelID, caps);
  }
  return out;
}

/** 归一 API 端点用于比对（去尾斜杠、小写主机名无关故只 trim 尾部）。 */
function normalizeApi(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  return v.replace(/\/+$/, '');
}

/**
 * 拉取 models.dev 全量目录。
 *
 * 失败（网络/超时/JSON 非法）→ 返回 null，由调用方按「本次跳过」处理：
 * 能力同步是增强，绝不能因为外部服务不可用而让平台功能报错。
 */
export async function fetchModelsDevCatalog(
  fetchImpl: typeof fetch = fetch,
  url: string = MODELS_DEV_URL,
): Promise<ModelsDevCatalog | null> {
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return body && typeof body === 'object' ? (body as ModelsDevCatalog) : null;
  } catch {
    return null;
  }
}
