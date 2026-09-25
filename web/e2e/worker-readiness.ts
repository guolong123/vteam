import type { APIRequestContext } from "@playwright/test";

const SERVER_URL = "http://localhost:13000";
const READINESS_INTERVAL_MS = 2_000;
const REQUIRED_STABLE_SAMPLES = 90;
const MAX_ATTEMPTS = 300;
const REQUEST_TIMEOUT_MS = 5_000;

type WorkerCatalog = {
  agents?: unknown[];
  degraded?: boolean;
};

type LoginResponse = {
  accessToken?: string;
};

/**
 * Wait until the worker's live catalogue has stayed usable for a complete
 * observation window. Policy tests enqueue several reload-config commands; a
 * single successful response is not enough because the worker can be between
 * two serve restarts. The window is deliberately bounded and fails loudly if
 * the catalogue never settles.
 */
export async function waitForWorkerCatalogSettled(
  request: APIRequestContext,
): Promise<void> {
  const login = await request.post(`${SERVER_URL}/api/v1/auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  if (!login.ok()) {
    throw new Error(`worker readiness login failed: HTTP ${login.status()}`);
  }
  const loginBody = (await login.json()) as LoginResponse;
  if (!loginBody.accessToken) {
    throw new Error("worker readiness login returned no access token");
  }

  const headers = { Authorization: `Bearer ${loginBody.accessToken}` };
  let stableSamples = 0;
  let lastFailure = "no response";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await request.get(`${SERVER_URL}/api/v1/agents/opencode`, {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      });
      if (response.ok()) {
        const body = (await response.json()) as WorkerCatalog;
        const agents = body.agents;
        if (body.degraded !== true && Array.isArray(agents) && agents.length > 0) {
          stableSamples += 1;
          if (stableSamples >= REQUIRED_STABLE_SAMPLES) return;
          lastFailure = `usable catalogue (${agents.length} agents)`;
        } else {
          stableSamples = 0;
          lastFailure = `degraded/empty catalogue (${agents?.length ?? 0} agents)`;
        }
      } else {
        stableSamples = 0;
        lastFailure = `HTTP ${response.status()}`;
      }
    } catch (error) {
      stableSamples = 0;
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, READINESS_INTERVAL_MS));
  }

  throw new Error(
    `worker catalogue did not stay ready for ${REQUIRED_STABLE_SAMPLES} samples ` +
      `within ${MAX_ATTEMPTS} attempts; last observation: ${lastFailure}`,
  );
}
