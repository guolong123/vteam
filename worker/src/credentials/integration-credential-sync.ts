/**
 * v2「integration 维度」凭据同步 —— 与配置段 `settings.apiKey` **正交**的另一半凭据载体。
 *
 * ── 为什么必须有这个模块 ─────────────────────────────────────────────
 * opencode v2 里 provider 的 API key 有**互不覆盖**的两个载体（实测见
 * docs/agent-platform/07-opencode-v2-调研与架构决策.md §12.5）：
 *
 * ① 配置文件 `providers.<id>.settings.apiKey` —— 仅对 **vteam 自配 baseUrl 的
 *    provider** 成立：`buildProviderSection` 会把「缺 baseUrl / 无模型」的条目整条跳过，
 *    所以像 `opencode-go` 这种**内置 integration**（vteam 库里没有 baseUrl）根本进不了
 *    配置段；
 * ② `POST /api/credential` → SQLite `credential` 表 —— **integration 维度**，v2 按
 *    `integrationID` 取 key（`opencode-go`/`openai`/`anthropic` 这类内置集成走这条）；
 * ③ legacy `auth.json` 实测是 no-op（v2.0.28 起的一次性导入迁移不生效）——
 *    **只写 auth.json = "注入成功但 serve 没有凭据"**。
 *
 * 本次线上故障正是 ①+③ 的组合：`opencode-go` 没有 baseUrl → 不进 provider 配置段 →
 * 只落 auth.json → serve 侧 `GET /api/provider` 里压根没有 `opencode-go`
 * （改 key 后模型目录依旧指向旧凭据状态，表现为"密钥改了没同步给 opencode 实例"）。
 * 本模块补上 ②。
 *
 * ── 语义（全量状态，幂等 diff）────────────────────────────────────────
 * - `providerKeys` = 全量**未吊销**凭据；其中**不在** `providerConfigs`（配置段）里的
 *   provider 视为 integration 维度 → 同步进 credential store；
 * - `revokedProviderIDs` = 已吊销的 providerID 全量清单 → 对应 store 行删除
 *   （吊销必须同步，否则 vteam 侧删了 key、serve 还拿着旧 key 继续跑）；
 * - 只在**真有差异**时写（POST/PATCH 不会造成"生效 → 回放 → 再生效"循环）；
 * - 写完回读 `GET /api/provider` 确认 provider 真的注册上了——写进去了但 provider
 *   仍不可见 = 静默失败，必须 warn（这正是原故障最难查的地方）。
 *
 * ⚠️ 日志只出现 providerID / 计数，**绝不出现 key 明文**。
 * ⚠️ 值变更用「DELETE + POST」而不是 PATCH：实测 PATCH `value` 不生效
 * （204 但 key 不变，PATCH 只认 `label`），更新必须重建行。
 */

import {
  requestServe as defaultRequestServe,
  ServeEndpoint,
  ServeResponse,
  unwrapServeList,
} from '../reload/config-reloader';

/** 一条凭据（provider → 明文 key，来自下行 model-credentials 命令）。 */
export interface IntegrationCredentialKey {
  providerID: string;
  key: string;
}

/** 同步请求（对齐 ModelCredentialsPayload 的凭据相关字段）。 */
export interface IntegrationCredentialSyncRequest {
  /** 全量未吊销凭据。 */
  providerKeys: IntegrationCredentialKey[];
  /** opencode.json 配置段（`providers.<id>` 全量状态）——这些 provider 不走本模块。 */
  providerConfigs?: Record<string, unknown>;
  /** 已吊销凭据的 providerID 全量清单（undefined = 旧 server，无吊销同步语义）。 */
  revokedProviderIDs?: string[];
}

/** 同步结果（供上层日志/测试断言；不含任何 key 明文）。 */
export interface IntegrationCredentialSyncSummary {
  /** credential store 读取成功（false = 未做任何同步）。 */
  ok: boolean;
  /** 新建的 integrationID。 */
  created: string[];
  /** 值变更（DELETE + POST 重建）的 integrationID。 */
  updated: string[];
  /** 因吊销删除的 integrationID。 */
  removed: string[];
  /** 值已一致、无需写入的条目数。 */
  unchanged: number;
  /** 写入后仍不在 serve provider 注册表里的 providerID（静默失败，须 warn）。 */
  missing: string[];
  /** 单条写入失败的 integrationID（best-effort，下一次回放会自愈）。 */
  failures: string[];
  /** 是否发生过写操作。 */
  changed: boolean;
}

/** serve 凭据行（`GET /api/credential` 的 data 项）。 */
interface CredentialRow {
  id?: unknown;
  integrationID?: unknown;
  value?: { key?: unknown } | null;
}

/** serve provider 项（`GET /api/provider` 的 data 项）。 */
interface ProviderRow {
  id?: unknown;
}

/** 带鉴权的 serve 请求函数（与 config-reloader.requestServe 同形）。 */
export type ServeRequester = (
  endpoint: ServeEndpoint | undefined,
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<ServeResponse>;

/** 依赖注入面（单测可 mock serve 请求）。 */
export interface IntegrationCredentialSyncDeps {
  /** serve 端点（Basic 鉴权口令从 serve 对象取，不从环境变量另读）。 */
  endpoint: ServeEndpoint | undefined;
  /** 带鉴权的 serve 请求；缺省用 config-reloader 的 requestServe。 */
  requestServe?: ServeRequester;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function emptySummary(ok: boolean): IntegrationCredentialSyncSummary {
  return {
    ok,
    created: [],
    updated: [],
    removed: [],
    unchanged: 0,
    missing: [],
    failures: [],
    changed: false,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 把「非配置段 provider」的凭据同步进 serve 的 credential store（全量状态、幂等 diff）。
 *
 * 失败策略：**读取失败抛错**（无法 diff，交上层 warn）；**单条写入失败只记 failures**
 * 并继续（best-effort——文件注入路径与其它 provider 不被一条坏行拖死）。
 */
export async function syncIntegrationCredentials(
  request: IntegrationCredentialSyncRequest,
  deps: IntegrationCredentialSyncDeps,
): Promise<IntegrationCredentialSyncSummary> {
  const log = deps.log ?? ((): void => undefined);
  const warn = deps.warn ?? ((): void => undefined);
  const doRequest: ServeRequester = deps.requestServe ?? defaultRequestServe;

  // 配置段 provider（有 baseUrl 走 opencode.json 的 settings.apiKey）不归本模块管。
  const configIds = new Set(Object.keys(request.providerConfigs ?? {}));
  const desired = new Map<string, string>();
  for (const entry of request.providerKeys ?? []) {
    const providerID = str(entry?.providerID);
    if (!providerID || !entry.key || configIds.has(providerID)) continue;
    desired.set(providerID, entry.key);
  }
  const revoked = new Set<string>();
  for (const raw of request.revokedProviderIDs ?? []) {
    const providerID = str(raw);
    // 配置段 provider 的吊销由 opencode.json 路径处理（buildProviderSection 会摘掉
    // settings.apiKey）；同 provider 同时出现在未吊销凭据里时以未吊销为准。
    if (!providerID || configIds.has(providerID) || desired.has(providerID)) continue;
    revoked.add(providerID);
  }
  if (desired.size === 0 && revoked.size === 0) {
    return emptySummary(true);
  }

  const listRes = await doRequest(deps.endpoint, '/api/credential');
  if (!listRes.ok) {
    throw new Error(`GET /api/credential HTTP ${listRes.status}`);
  }
  const rows = unwrapServeList(listRes.json).filter(
    (row): row is CredentialRow => row !== null && typeof row === 'object',
  );

  const summary = emptySummary(true);
  for (const [providerID, key] of desired) {
    const matches = rows.filter((row) => str(row.integrationID) === providerID);
    const row = matches[0];
    if (!row) {
      const created = await createCredential(doRequest, deps, providerID, key);
      if (created) summary.created.push(providerID);
      else summary.failures.push(providerID);
      continue;
    }
    const current = str(row.value?.key);
    if (current === key) {
      summary.unchanged += 1;
      continue;
    }
    // 值变更：DELETE + POST（PATCH 的 value 实测不生效）。
    const rowId = str(row.id);
    if (!rowId) {
      summary.failures.push(providerID);
      warn(`[worker] credential store：provider=${providerID} 行缺少 id，无法更新`);
      continue;
    }
    try {
      const del = await doRequest(deps.endpoint, `/api/credential/${rowId}`, {
        method: 'DELETE',
      });
      if (!del.ok) {
        summary.failures.push(providerID);
        warn(
          `[worker] credential store：provider=${providerID} 旧凭据删除失败 HTTP ${del.status}`,
        );
        continue;
      }
    } catch (err) {
      summary.failures.push(providerID);
      warn(
        `[worker] credential store：provider=${providerID} 旧凭据删除失败: ${(err as Error).message}`,
      );
      continue;
    }
    const created = await createCredential(doRequest, deps, providerID, key);
    if (created) summary.updated.push(providerID);
    else summary.failures.push(providerID);
  }

  if (revoked.size > 0) {
    for (const row of rows) {
      const providerID = str(row.integrationID);
      const rowId = str(row.id);
      if (!providerID || !rowId || !revoked.has(providerID)) continue;
      try {
        const del = await doRequest(deps.endpoint, `/api/credential/${rowId}`, {
          method: 'DELETE',
        });
        if (del.ok) summary.removed.push(providerID);
        else {
          summary.failures.push(providerID);
          warn(
            `[worker] credential store：provider=${providerID} 吊销删除失败 HTTP ${del.status}`,
          );
        }
      } catch (err) {
        summary.failures.push(providerID);
        warn(
          `[worker] credential store：provider=${providerID} 吊销删除失败: ${(err as Error).message}`,
        );
      }
    }
  }

  summary.changed =
    summary.created.length > 0 ||
    summary.updated.length > 0 ||
    summary.removed.length > 0;

  if (summary.changed) {
    log(
      `[worker] credential store 已同步：新建=[${summary.created.join(', ') || '无'}] ` +
        `更新=[${summary.updated.join(', ') || '无'}] 吊销删除=[${summary.removed.join(', ') || '无'}]`,
    );
    // 写入 ≠ 生效：回读 provider 注册表，写进去了但 provider 不在 = 静默失败（本次
    // 线上故障的形态），必须显式 warn。
    summary.missing = await verifyProvidersVisible(
      doRequest,
      deps,
      [...summary.created, ...summary.updated],
    );
    if (summary.missing.length > 0) {
      warn(
        `[worker] credential store：provider=[${summary.missing.join(', ')}] 凭据已写入但 serve 未注册该 provider` +
          `（既无 baseUrl 配置段也不是已知 integration）→ 该 provider 的模型不可用`,
      );
    }
  }
  if (summary.failures.length > 0) {
    warn(
      `[worker] credential store：${summary.failures.length} 条凭据写入失败（provider=[${summary.failures.join(', ')}]），下次回放自愈`,
    );
  }
  return summary;
}

/** 写一条 credential（POST），成功 true / 失败 false（失败只 warn 不抛）。 */
async function createCredential(
  doRequest: ServeRequester,
  deps: IntegrationCredentialSyncDeps,
  providerID: string,
  key: string,
): Promise<boolean> {
  try {
    const res = await doRequest(deps.endpoint, '/api/credential', {
      method: 'POST',
      // integrationID 未知也接受（store 按行存）；visibility 校验负责发现"存得进但不生效"。
      body: { integrationID: providerID, value: { type: 'key', key } },
    });
    if (!res.ok) {
      (deps.warn ?? ((): void => undefined))(
        `[worker] credential store：provider=${providerID} 凭据写入失败 HTTP ${res.status}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    (deps.warn ?? ((): void => undefined))(
      `[worker] credential store：provider=${providerID} 凭据写入失败: ${(err as Error).message}`,
    );
    return false;
  }
}

/** 回读 `GET /api/provider`，返回仍不可见的 providerID。 */
async function verifyProvidersVisible(
  doRequest: ServeRequester,
  deps: IntegrationCredentialSyncDeps,
  providerIDs: string[],
): Promise<string[]> {
  if (providerIDs.length === 0) return [];
  const warn = deps.warn ?? ((): void => undefined);
  try {
    const res = await doRequest(deps.endpoint, '/api/provider');
    if (!res.ok) {
      warn(`[worker] credential store：GET /api/provider HTTP ${res.status}（无法确认 provider 生效）`);
      return [];
    }
    const visible = new Set(
      unwrapServeList(res.json)
        .filter((row): row is ProviderRow => row !== null && typeof row === 'object')
        .map((row) => str(row.id))
        .filter((id): id is string => id !== null),
    );
    return providerIDs.filter((id) => !visible.has(id));
  } catch (err) {
    warn(`[worker] credential store：确认 provider 生效失败: ${(err as Error).message}`);
    return [];
  }
}
