import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ExecutionConfig {
  permissions: Record<string, 'allow' | 'ask' | 'deny'>;
  writePaths: string[];
}

const DEFAULT_MINIMAL: ExecutionConfig = {
  permissions: { '*': 'ask' },
  writePaths: [],
};

@Injectable()
export class ExecutionPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveExecutionConfig(agent: { policyId?: string | null }): Promise<ExecutionConfig> {
    if (!agent.policyId) {
      return DEFAULT_MINIMAL;
    }
    const policy = await this.prisma.executionPolicy.findUnique({
      where: { id: agent.policyId },
      select: { config: true },
    });
    if (!policy || !policy.config) {
      return DEFAULT_MINIMAL;
    }
    const cfg = policy.config as unknown as ExecutionConfig;
    if (!cfg.permissions || typeof cfg.permissions !== 'object') {
      return DEFAULT_MINIMAL;
    }
    return {
      permissions: cfg.permissions,
      writePaths: Array.isArray(cfg.writePaths) ? cfg.writePaths : [],
    };
  }
}
