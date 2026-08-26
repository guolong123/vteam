import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { GitRepo, GitRepoGrant } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { WorkersService } from '../workers/workers.service';
import { CreateGitRepoDto, GitGrantInput } from './dto/create-git-repo.dto';
import { UpdateGitRepoDto } from './dto/update-git-repo.dto';
import {
  GIT_REPOS_ERRORS,
  GIT_REPO_GRANT_ID_PREFIX,
  GIT_REPO_ID_PREFIX,
} from './git-repos.constants';

interface NormalizedGrant {
  agentId: string;
  permission: 'read' | 'write';
  effect: 'allow' | 'ask';
}

export interface GitRepoView {
  id: string;
  repoUrl: string;
  credentialId: string;
  credentialName: string | null;
  authType: string;
  fingerprint: string;
  revokedAt: Date | null;
  createdAt: Date;
  grantedAgents: Array<{
    agentId: string;
    name: string | null;
    permission: string;
    effect: string;
  }>;
}

export function normalizeRepoUrl(url: string): string {
  const trimmed = (url ?? '').trim();
  const noGitSuffix = trimmed.replace(/\.git$/i, '');
  return noGitSuffix.replace(/^([a-z]+):\/\//i, (_, proto: string) => {
    return `${proto.toLowerCase()}://`;
  });
}

@Injectable()
export class GitReposService implements OnModuleInit {
  private readonly logger = new Logger(GitReposService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    @Inject(forwardRef(() => WorkersService))
    private readonly workers: WorkersService,
  ) {}

  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      (this.prisma as any).gitRepo,
      GIT_REPO_ID_PREFIX,
      this.idGen,
    );
    await resyncIdPrefix(
      this.prisma.gitRepoGrant,
      GIT_REPO_GRANT_ID_PREFIX,
      this.idGen,
    );
  }

  async findAll(): Promise<GitRepoView[]> {
    const [repos, credentials, grants, agents] = await Promise.all([
      (this.prisma as any).gitRepo.findMany({
        where: { revokedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.gitCredential.findMany({
        where: { revokedAt: null },
      }),
      this.prisma.gitRepoGrant.findMany({ where: { revokedAt: null } }),
      this.prisma.agent.findMany({ select: { id: true, name: true } }),
    ]);
    const credById = new Map(credentials.map((c: any) => [c.id, c]));
    const nameById = new Map(agents.map((a: any) => [a.id, a.name]));
    const grantsByRepo = new Map<string, GitRepoGrant[]>();
    for (const g of grants) {
      const list = grantsByRepo.get((g as any).repoId) ?? [];
      list.push(g);
      grantsByRepo.set((g as any).repoId, list);
    }
    return (repos as GitRepo[]).map((r) =>
      this.toView(
        r,
        credById.get((r as any).credentialId),
        grantsByRepo.get(r.id) ?? [],
        nameById,
      ),
    );
  }

  async create(dto: CreateGitRepoDto, userId: string): Promise<GitRepoView> {
    const repoUrl = normalizeRepoUrl(dto.repoUrl);
    if (!repoUrl) {
      throw new BadRequestException({
        code: GIT_REPOS_ERRORS.REPO_NOT_FOUND,
        message: 'repoUrl 不能为空',
      });
    }
    const credential = await this.prisma.gitCredential.findUnique({
      where: { id: dto.credentialId },
    });
    if (!credential || (credential as any).revokedAt !== null) {
      throw new NotFoundException({
        code: GIT_REPOS_ERRORS.CREDENTIAL_NOT_FOUND,
        message: `凭证 ${dto.credentialId} 不存在或已吊销`,
      });
    }
    const grants = this.normalizeGrants(dto.grantedAgents ?? []);
    const existing = await (this.prisma as any).gitRepo.findUnique({
      where: { repoUrl },
      select: { id: true, revokedAt: true },
    });
    if (existing && existing.revokedAt === null) {
      throw new ConflictException({
        code: GIT_REPOS_ERRORS.REPO_EXISTS,
        message: `仓库 ${repoUrl} 已存在`,
      });
    }
    await this.assertAgentsExist(grants.map((g) => g.agentId));

    let repoId: string;
    if (existing) {
      await (this.prisma as any).gitRepo.update({
        where: { id: existing.id },
        data: {
          credentialId: dto.credentialId,
          createdBy: userId,
          revokedAt: null,
        },
      });
      repoId = existing.id;
    } else {
      const row = await (this.prisma as any).gitRepo.create({
        data: {
          id: await this.idGen.nextId(GIT_REPO_ID_PREFIX),
          repoUrl,
          credentialId: dto.credentialId,
          createdBy: userId,
        },
      });
      repoId = row.id;
    }

    await this.prisma.gitRepoGrant.updateMany({
      where: { repoId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.createGrants(repoId, grants, userId);

    this.logger.log(
      `仓库创建：repo=${repoUrl} credential=${(credential as any).name} grants=${grants.length}`,
    );
    await this.dispatchAfterSave();
    return this.findView(repoId);
  }

  async update(
    id: string,
    dto: UpdateGitRepoDto,
    userId: string,
  ): Promise<GitRepoView> {
    const existing = await (this.prisma as any).gitRepo.findUnique({
      where: { id },
    });
    if (!existing || existing.revokedAt !== null) {
      this.throwNotFound(id);
    }

    if (dto.credentialId !== undefined) {
      const cred = await this.prisma.gitCredential.findUnique({
        where: { id: dto.credentialId },
      });
      if (!cred || (cred as any).revokedAt !== null) {
        throw new NotFoundException({
          code: GIT_REPOS_ERRORS.CREDENTIAL_NOT_FOUND,
          message: `凭证 ${dto.credentialId} 不存在或已吊销`,
        });
      }
      await (this.prisma as any).gitRepo.update({
        where: { id },
        data: { credentialId: dto.credentialId },
      });
      this.logger.log(
        `仓库凭证切换：repo=${existing.repoUrl} credentialId=${dto.credentialId}`,
      );
    }

    if (dto.grantedAgents !== undefined) {
      const grants = this.normalizeGrants(dto.grantedAgents);
      await this.assertAgentsExist(grants.map((g) => g.agentId));
      await this.prisma.gitRepoGrant.updateMany({
        where: { repoId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.createGrants(id, grants, userId);
    }

    await this.dispatchAfterSave();
    return this.findView(id);
  }

  async remove(
    id: string,
    userId: string,
  ): Promise<{ id: string; revokedAt: Date }> {
    const existing = await (this.prisma as any).gitRepo.findUnique({
      where: { id },
    });
    if (!existing || existing.revokedAt !== null) {
      this.throwNotFound(id);
    }
    const now = new Date();
    await (this.prisma as any).gitRepo.update({
      where: { id },
      data: { revokedAt: now },
    });
    await this.prisma.gitRepoGrant.updateMany({
      where: { repoId: id, revokedAt: null },
      data: { revokedAt: now },
    });
    this.logger.log(`仓库吊销：repo=${existing.repoUrl} by=${userId}`);
    await this.dispatchAfterSave();
    return { id, revokedAt: now };
  }

  private async dispatchAfterSave(): Promise<void> {
    try {
      await this.workers.dispatchGitCredentials();
    } catch (err) {
      this.logger.warn(
        `git 凭证下发失败（已落库，worker 注册回放兜底）: ${(err as Error).message}`,
      );
    }
  }

  private normalizeGrants(input: GitGrantInput[]): NormalizedGrant[] {
    return input.map((g) => {
      const permission = g.permission ?? 'read';
      const effect = g.effect ?? (permission === 'write' ? 'ask' : 'allow');
      return { agentId: g.agentId, permission, effect };
    });
  }

  private async assertAgentsExist(agentIds: string[]): Promise<void> {
    if (agentIds.length === 0) return;
    const found = await this.prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: { id: true },
    });
    const foundSet = new Set(found.map((a) => a.id));
    const missing = agentIds.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new BadRequestException({
        code: GIT_REPOS_ERRORS.GRANT_INVALID,
        message: `授权 Agent 不存在: ${missing.join(', ')}`,
      });
    }
  }

  private async createGrants(
    repoId: string,
    grants: NormalizedGrant[],
    userId: string,
  ): Promise<void> {
    if (grants.length === 0) return;
    await this.prisma.gitRepoGrant.deleteMany({
      where: { repoId, revokedAt: { not: null } },
    });
    const rows = [];
    for (const g of grants) {
      rows.push({
        id: await this.idGen.nextId(GIT_REPO_GRANT_ID_PREFIX),
        agentId: g.agentId,
        repoId,
        permission: g.permission,
        effect: g.effect,
        grantedBy: userId,
      });
    }
    await this.prisma.gitRepoGrant.createMany({ data: rows });
  }

  private async findView(repoId: string): Promise<GitRepoView> {
    const repo = await (this.prisma as any).gitRepo.findUnique({
      where: { id: repoId },
    });
    if (!repo) this.throwNotFound(repoId);
    const [credential, grants, agents] = await Promise.all([
      this.prisma.gitCredential.findUnique({
        where: { id: (repo as any).credentialId },
      }),
      this.prisma.gitRepoGrant.findMany({ where: { repoId, revokedAt: null } }),
      this.prisma.agent.findMany({ select: { id: true, name: true } }),
    ]);
    return this.toView(
      repo,
      credential as any,
      grants,
      new Map(agents.map((a) => [a.id, a.name])),
    );
  }

  private toView(
    repo: GitRepo,
    credential: any,
    grants: GitRepoGrant[],
    nameById: Map<string, string>,
  ): GitRepoView {
    return {
      id: repo.id,
      repoUrl: (repo as any).repoUrl,
      credentialId: (repo as any).credentialId,
      credentialName: credential?.name ?? null,
      authType: credential?.authType ?? '',
      fingerprint: credential?.fingerprint ?? '',
      revokedAt: (repo as any).revokedAt,
      createdAt: (repo as any).createdAt,
      grantedAgents: grants.map((g) => ({
        agentId: (g as any).agentId,
        name: nameById.get((g as any).agentId) ?? null,
        permission: (g as any).permission,
        effect: (g as any).effect,
      })),
    };
  }

  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: GIT_REPOS_ERRORS.REPO_NOT_FOUND,
      message: `仓库 ${id} 不存在或已吊销`,
    });
  }
}
