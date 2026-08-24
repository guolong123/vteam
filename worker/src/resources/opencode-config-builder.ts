import type { ExecutionConfig } from '../protocol/worker-protocol';

export interface OpencodeArtifacts {
  agentName: string;
  permission: Record<string, 'allow' | 'ask' | 'deny'>;
  writePaths: string[];
}

export function buildOpencodeConfig(
  executionConfig: ExecutionConfig,
  policyId?: string,
): OpencodeArtifacts {
  // Deterministic agentName derived from policyId (or config hash fallback) to avoid
  // per-invocation randomness breaking session affinity and cache.
  const stableId = policyId ?? hashPermissions(executionConfig.permissions);
  return {
    agentName: `policy-${stableId.slice(0, 8)}`,
    permission: executionConfig.permissions,
    writePaths: executionConfig.writePaths,
  };
}

function hashPermissions(permissions: Record<string, string>): string {
  const keys = Object.keys(permissions).sort();
  const payload = keys.map((k) => `${k}:${permissions[k]}`).join('|');
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = (hash * 31 + payload.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).padStart(8, '0');
}
