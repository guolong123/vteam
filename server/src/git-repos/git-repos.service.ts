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
import { GitCredential, GitRepoGrant } from '@prisma/client';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { WorkersService } from '../workers/workers.service';
import { CreateGitRepoDto, GitGrantInput } from './dto/create-git-repo.dto';
import { UpdateGitRepoDto } from './dto/update-git-repo.dto';
import {
  GIT_AUTH_TYPES,
  GIT_CREDENTIAL_ID_PREFIX,
  GIT_REPOS_ERRORS,
  GIT_REPO_GRANT_ID_PREFIX,
} from './git-repos.constants';

/** 授权条目规范化后的内部形状（permission/effect 已补齐默认值）。 */
interface NormalizedGrant {
  agentId: string;
  permission: 'read' | 'write';
  effect: 'allow' | 'ask';
}

/** 仓库凭证对外视图（脱敏：绝不携带 credentialRef/key 明文，17 篇 §3.4 明文零接触）。 */
export interface GitRepoView {
  id: string;
  repoUrl: string;
  authType: string;
  /** 脱敏标识（ssh-rsa AAAA**** / gh_****），非明文凭证。 */
  fingerprint: string;
  revokedAt: Date | null;
  createdAt: Date;
  /** 未吊销授权列表（join GitRepoGrant revokedAt=null + Agent.name）。 */
  grantedAgents: Array<{
    agentId: string;
    name: string | null;
    permission: string;
    effect: string;
  }>;
}

/**
 * 仓库地址规范化（导出供测试）：trim → 去尾部 `.git`（大小写不敏感）→ 协议小写。
 * - `git@gitee.com:xishuhq/test-repo.git` → `git@gitee.com:xishuhq/test-repo`
 *   （scp-like 无协议，git@ 前缀原样保留）；
 * - `HTTPS://GITEE.COM/xishuhq/test.git` → `https://GITEE.COM/xishuhq/test`
 *   （仅协议小写，host 原样——所有入口统一走本函数，repoUrl 对比稳定）。
 */
export function normalizeRepoUrl(url: string): string {
  const trimmed = (url ?? '').trim();
  const noGitSuffix = trimmed.replace(/\.git$/i, '');
  return noGitSuffix.replace(/^([a-z]+):\/\//i, (_, proto: string) => {
    return `${proto.toLowerCase()}://`;
  });
}

/**
 * 仓库凭证服务（17 篇《仓库权限与凭证机制》B 方案 server 侧落地）。
 *
 * - create/update：SSH 私钥 / HTTPS token 经 CredentialCryptoService AES-256-GCM
 *   加密存 credentialRef，fingerprint 脱敏；授权（GitRepoGrant）按 agent 粒度维护；
 * - findAll：仅未吊销凭证 + 未吊销授权 + Agent.name 组装 View，绝不返回明文；
 * - remove：软撤销凭证（revokedAt）+ 该 repoUrl 全部授权软撤销（保留审计轨迹）；
 * - 保存/吊销后触发 WorkersService.dispatchGitCredentials（按 worker 承载活跃 agent
 *   的授权仓库过滤打包下行，凭证面=worker 级；下发失败不阻断——注册回放兜底）。
 */
@Injectable()
export class GitReposService implements OnModuleInit {
  private readonly logger = new Logger(GitReposService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly crypto: CredentialCryptoService,
    // 保存/吊销后触发按 worker 过滤下行（forwardRef——WorkersService 亦依赖
    // CredentialCryptoService 做回放解密，双向循环仿 ModelsService:68-75）。
    @Inject(forwardRef(() => WorkersService))
    private readonly workers: WorkersService,
  ) {}

  /** 进程启动对齐 gc_/gr_ 前缀序号（重启续号，幂等——models.service onModuleInit 亦已挂接）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.gitCredential, GIT_CREDENTIAL_ID_PREFIX, this.idGen);
    await resyncIdPrefix(this.prisma.gitRepoGrant, GIT_REPO_GRANT_ID_PREFIX, this.idGen);
  }

  /**
   * GET /git-repos：未吊销仓库凭证列表（含授权 agents，成员只读）。
   * 数据源三查（凭证 + 授权 + agent 名）内存组装；排序 createdAt asc + id asc
   * （对齐 models findAll 稳定排序）。
   */
  async findAll(): Promise<GitRepoView[]> {
    const [credentials, grants, agents] = await Promise.all([
      this.prisma.gitCredential.findMany({
        where: { revokedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.gitRepoGrant.findMany({ where: { revokedAt: null } }),
      this.prisma.agent.findMany({ select: { id: true, name: true } }),
    ]);
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    const grantsByRepo = new Map<string, GitRepoGrant[]>();
    for (const g of grants) {
      const list = grantsByRepo.get(g.repoUrl) ?? [];
      list.push(g);
      grantsByRepo.set(g.repoUrl, list);
    }
    return credentials.map((c) =>
      this.toView(c, grantsByRepo.get(c.repoUrl) ?? [], nameById),
    );
  }

  /**
   * POST /git-repos：录入仓库凭证 + 授权。
   * - repoUrl 规范化（去 .git）→ authType 校验 → 唯一键查冲突；
   * - 未吊销重复 → 409 REPO_EXISTS；已吊销历史行 → 覆盖激活（清除 revokedAt）；
   * - key 加密存 credentialRef + fingerprint 脱敏；授权逐条落 GitRepoGrant；
   * - 保存后触发 worker 按活跃 agent 过滤下发（失败不阻断）。
   * 返回脱敏 View（无 key 明文）。
   */
  async create(dto: CreateGitRepoDto, userId: string): Promise<GitRepoView> {
    const repoUrl = normalizeRepoUrl(dto.repoUrl);
    if (!repoUrl) {
      throw new BadRequestException({
        code: GIT_REPOS_ERRORS.AUTH_TYPE_INVALID,
        message: 'repoUrl 不能为空',
      });
    }
    if (dto.authType !== GIT_AUTH_TYPES.SSH_KEY && dto.authType !== GIT_AUTH_TYPES.HTTPS_TOKEN) {
      throw new BadRequestException({
        code: GIT_REPOS_ERRORS.AUTH_TYPE_INVALID,
        message: `authType 仅支持 ${GIT_AUTH_TYPES.SSH_KEY}|${GIT_AUTH_TYPES.HTTPS_TOKEN}`,
      });
    }
    const grants = this.normalizeGrants(dto.grantedAgents ?? []);

    const existing = await this.prisma.gitCredential.findUnique({
      where: { repoUrl_authType: { repoUrl, authType: dto.authType } },
      select: { id: true, revokedAt: true },
    });
    if (existing && existing.revokedAt === null) {
      throw new ConflictException({
        code: GIT_REPOS_ERRORS.REPO_EXISTS,
        message: `仓库 ${repoUrl} 的 ${dto.authType} 凭证已存在`,
      });
    }
    await this.assertAgentsExist(grants.map((g) => g.agentId));

    const credentialRef = this.crypto.encrypt(dto.key);
    const fingerprint = this.crypto.fingerprint(dto.key);

    let credentialId: string;
    if (existing) {
      // 已吊销历史行 → 覆盖激活（重新录入语义，清除 revokedAt）
      await this.prisma.gitCredential.update({
        where: { id: existing.id },
        data: { credentialRef, fingerprint, createdBy: userId, revokedAt: null },
      });
      credentialId = existing.id;
    } else {
      const row = await this.prisma.gitCredential.create({
        data: {
          id: await this.idGen.nextId(GIT_CREDENTIAL_ID_PREFIX),
          repoUrl,
          authType: dto.authType,
          credentialRef,
          fingerprint,
          createdBy: userId,
        },
      });
      credentialId = row.id;
    }

    // 覆盖激活的防御性清理：旧授权（若有残留未软撤）一并软撤，再写全新授权
    await this.prisma.gitRepoGrant.updateMany({
      where: { repoUrl, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.createGrants(repoUrl, grants, userId);

    this.logger.log(
      `仓库凭证录入：repo=${repoUrl} authType=${dto.authType} fingerprint=${fingerprint} grants=${grants.length}`,
    );
    await this.dispatchAfterSave();
    return this.findView(credentialId);
  }

  /**
   * PATCH /git-repos/:id：部分更新（key 重加密 / 授权全量覆盖，全可选）。
   * - 不存在或已吊销 → 404 REPO_NOT_FOUND；
   * - key 提供 → 重加密覆盖 credentialRef/fingerprint；
   * - grantedAgents 提供 → 全量覆盖授权：软撤旧 → 写新；
   * - 保存后触发下发。
   */
  async update(
    id: string,
    dto: UpdateGitRepoDto,
    userId: string,
  ): Promise<GitRepoView> {
    const existing = await this.prisma.gitCredential.findUnique({
      where: { id },
    });
    if (!existing || existing.revokedAt !== null) {
      this.throwNotFound(id);
    }
    const repoUrl = existing.repoUrl;

    if (dto.key !== undefined) {
      const credentialRef = this.crypto.encrypt(dto.key);
      const fingerprint = this.crypto.fingerprint(dto.key);
      await this.prisma.gitCredential.update({
        where: { id },
        data: { credentialRef, fingerprint },
      });
      this.logger.log(
        `仓库凭证重加密：repo=${repoUrl} fingerprint=${fingerprint}`,
      );
    }

    if (dto.grantedAgents !== undefined) {
      const grants = this.normalizeGrants(dto.grantedAgents);
      await this.assertAgentsExist(grants.map((g) => g.agentId));
      await this.prisma.gitRepoGrant.updateMany({
        where: { repoUrl, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.createGrants(repoUrl, grants, userId);
    }

    await this.dispatchAfterSave();
    return this.findView(id);
  }

  /**
   * DELETE /git-repos/:id：软撤销（凭证 + 该 repoUrl 全部授权）。
   * - 不存在或已吊销 → 404 REPO_NOT_FOUND；
   * - 吊销后触发下发（清 worker 侧凭证条目，场景 D 即时生效）。
   */
  async remove(id: string, userId: string): Promise<{ id: string; revokedAt: Date }> {
    const existing = await this.prisma.gitCredential.findUnique({
      where: { id },
    });
    if (!existing || existing.revokedAt !== null) {
      this.throwNotFound(id);
    }
    const now = new Date();
    await this.prisma.gitCredential.update({
      where: { id },
      data: { revokedAt: now },
    });
    await this.prisma.gitRepoGrant.updateMany({
      where: { repoUrl: existing.repoUrl, revokedAt: null },
      data: { revokedAt: now },
    });
    this.logger.log(
      `仓库凭证吊销：repo=${existing.repoUrl} by=${userId} fingerprint=${existing.fingerprint}`,
    );
    await this.dispatchAfterSave();
    return { id, revokedAt: now };
  }

  // ==================================================================
  // 私有辅助
  // ==================================================================

  /** 保存/吊销后触发 worker 按活跃 agent 过滤下发（失败不阻断，注册回放兜底）。 */
  private async dispatchAfterSave(): Promise<void> {
    try {
      await this.workers.dispatchGitCredentials();
    } catch (err) {
      this.logger.warn(
        `git 凭证下发失败（凭证已落库，worker 注册回放兜底）: ${(err as Error).message}`,
      );
    }
  }

  /** 授权条目规范化：permission/effect 缺省补齐（read→allow、write→ask）。 */
  private normalizeGrants(input: GitGrantInput[]): NormalizedGrant[] {
    return input.map((g) => {
      const permission = g.permission ?? 'read';
      const effect = g.effect ?? (permission === 'write' ? 'ask' : 'allow');
      return { agentId: g.agentId, permission, effect };
    });
  }

  /** 授权主体存在性校验：任一 agent 不存在 → 400 GRANT_INVALID（防幽灵授权）。 */
  private async assertAgentsExist(agentIds: string[]): Promise<void> {
    if (agentIds.length === 0) {
      return;
    }
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

  /** 批量写 GitRepoGrant（id 由 idGen 生成，grantedBy=操作者）。 */
  private async createGrants(
    repoUrl: string,
    grants: NormalizedGrant[],
    userId: string,
  ): Promise<void> {
    if (grants.length === 0) {
      return;
    }
    // 物理清理该仓库已软撤的旧授权占位行：@@unique([agentId, repoUrl]) 不含
    // revokedAt，软撤行仍占唯一索引，若不清理，授权重建（PATCH 全量覆盖 /
    // POST 覆盖激活）的 createMany 会撞 uk_git_repo_grants_agent_repo 唯一约束。
    await this.prisma.gitRepoGrant.deleteMany({
      where: { repoUrl, revokedAt: { not: null } },
    });
    const rows = [];
    for (const g of grants) {
      rows.push({
        id: await this.idGen.nextId(GIT_REPO_GRANT_ID_PREFIX),
        agentId: g.agentId,
        repoUrl,
        permission: g.permission,
        effect: g.effect,
        grantedBy: userId,
      });
    }
    await this.prisma.gitRepoGrant.createMany({ data: rows });
  }

  /** 单条凭证组装 View（凭证 + 未吊销授权 + agent 名），凭证不存在 → 404。 */
  private async findView(credentialId: string): Promise<GitRepoView> {
    const cred = await this.prisma.gitCredential.findUnique({
      where: { id: credentialId },
    });
    if (!cred) {
      this.throwNotFound(credentialId);
    }
    const [grants, agents] = await Promise.all([
      this.prisma.gitRepoGrant.findMany({
        where: { repoUrl: cred.repoUrl, revokedAt: null },
      }),
      this.prisma.agent.findMany({ select: { id: true, name: true } }),
    ]);
    return this.toView(
      cred,
      grants,
      new Map(agents.map((a) => [a.id, a.name])),
    );
  }

  /** 行 → 脱敏视图（grantedAgents 仅含未吊销授权，无 credentialRef/key 明文）。 */
  private toView(
    cred: GitCredential,
    grants: GitRepoGrant[],
    nameById: Map<string, string>,
  ): GitRepoView {
    return {
      id: cred.id,
      repoUrl: cred.repoUrl,
      authType: cred.authType,
      fingerprint: cred.fingerprint,
      revokedAt: cred.revokedAt,
      createdAt: cred.createdAt,
      grantedAgents: grants.map((g) => ({
        agentId: g.agentId,
        name: nameById.get(g.agentId) ?? null,
        permission: g.permission,
        effect: g.effect,
      })),
    };
  }

  /** 404：REPO_NOT_FOUND（不存在或已吊销）。 */
  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: GIT_REPOS_ERRORS.REPO_NOT_FOUND,
      message: `仓库凭证 ${id} 不存在或已吊销`,
    });
  }
}
