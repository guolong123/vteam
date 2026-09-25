import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkersService } from '../workers/workers.service';

/**
 * 外部引擎 Agent 名的弱校验器（todo 2）。
 *
 * 语义镜像 `teams.service.ts` 的 `warnIfOpencodeAgentUnknown`：能取到 worker 的 agent 清单则
 * 核对并告警，取不到（无在线 worker / worker 离线 / 旧版无 `GET /agent`）静默放行——
 * **绝不因校验失败阻断用户写入**。权威判定在执行期：名不存在由 opencode 报错并经既有
 * agent.status error 通路回流，不把 worker 可用性耦合进角色编辑这一纯配置操作。
 *
 * 取数路径镜像 `agents.service.ts#listOpencodeAgents`：必须带 worker 行（capabilities）
 * 调用 `listAgents`——exec 端点 baseUrl 从 `capabilities.execBaseUrl` 解析，只传 `{ id }`
 * 会回落 localhost，server 与 worker 分处不同容器时必然连不上（静默返回 `[]`），
 * 弱校验将永远不告警。
 */
@Injectable()
export class OpencodeAgentNameValidator {
  private readonly logger = new Logger(OpencodeAgentNameValidator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workersService: WorkersService,
    private readonly workerClient: WorkerClient,
  ) {}

  async warnIfUnknown(agentName: string, roleId: string): Promise<void> {
    try {
      const workerId = await this.workersService.assignWorker();
      if (!workerId) {
        return;
      }
      const worker = await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { id: true, capabilities: true },
      });
      if (!worker) {
        this.logger.warn(
          `[agent-roles] worker ${workerId} 行缺失，无法解析执行端点，跳过 agent 名弱校验 ` +
            `defaultOpencodeAgentName="${agentName}"（role=${roleId}）；仍按用户意图写入`,
        );
        return;
      }
      // listAgents 自带降级日志（worker id + 解析出的 URL + 不可达/空区分），此处不再静默吞错
      const agents = await this.workerClient.listAgents(worker);
      if (agents.length === 0) {
        return;
      }
      if (!agents.some((a) => a.name === agentName)) {
        this.logger.warn(
          `[agent-roles] defaultOpencodeAgentName="${agentName}"（role=${roleId}）不在 worker ${workerId} 的 agent 清单中，` +
            `仍按用户意图写入；执行期若不存在将由 opencode 报错`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[agent-roles] agent 名弱校验失败，放行写入 ` +
          `defaultOpencodeAgentName="${agentName}"（role=${roleId}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
