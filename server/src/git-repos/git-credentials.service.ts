import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { GitCredential } from '@prisma/client';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGitCredentialDto } from './dto/create-git-credential.dto';
import { UpdateGitCredentialDto } from './dto/update-git-credential.dto';
import {
  GIT_AUTH_TYPES,
  GIT_CREDENTIAL_ID_PREFIX,
  GIT_REPOS_ERRORS,
} from './git-repos.constants';

export interface GitCredentialView {
  id: string;
  name: string;
  authType: string;
  fingerprint: string;
  description: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class GitCredentialsService implements OnModuleInit {
  private readonly logger = new Logger(GitCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly crypto: CredentialCryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.gitCredential, GIT_CREDENTIAL_ID_PREFIX, this.idGen);
  }

  async findAll(): Promise<GitCredentialView[]> {
    const rows = await this.prisma.gitCredential.findMany({
      where: { revokedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.toView(r));
  }

  async create(dto: CreateGitCredentialDto, userId: string): Promise<GitCredentialView> {
    if (dto.authType !== GIT_AUTH_TYPES.SSH_KEY && dto.authType !== GIT_AUTH_TYPES.HTTPS_TOKEN) {
      throw new BadRequestException({
        code: GIT_REPOS_ERRORS.AUTH_TYPE_INVALID,
        message: `authType 仅支持 ${GIT_AUTH_TYPES.SSH_KEY}|${GIT_AUTH_TYPES.HTTPS_TOKEN}`,
      });
    }
    const existing = await this.prisma.gitCredential.findUnique({
      where: { name: dto.name },
      select: { id: true, revokedAt: true },
    });
    if (existing && existing.revokedAt === null) {
      throw new ConflictException({
        code: GIT_REPOS_ERRORS.CREDENTIAL_NAME_EXISTS,
        message: `凭证名称 ${dto.name} 已存在`,
      });
    }
    const credentialRef = this.crypto.encrypt(dto.key);
    const fingerprint = this.crypto.fingerprint(dto.key);

    let credentialId: string;
    if (existing) {
      await this.prisma.gitCredential.update({
        where: { id: existing.id },
        data: {
          authType: dto.authType,
          credentialRef,
          fingerprint,
          description: dto.description ?? null,
          createdBy: userId,
          revokedAt: null,
        },
      });
      credentialId = existing.id;
    } else {
      const row = await this.prisma.gitCredential.create({
        data: {
          id: await this.idGen.nextId(GIT_CREDENTIAL_ID_PREFIX),
          name: dto.name,
          authType: dto.authType,
          credentialRef,
          fingerprint,
          description: dto.description ?? null,
          createdBy: userId,
        },
      });
      credentialId = row.id;
    }
    this.logger.log(`凭证创建：name=${dto.name} authType=${dto.authType} fingerprint=${fingerprint}`);
    return this.findView(credentialId);
  }

  async update(id: string, dto: UpdateGitCredentialDto, userId: string): Promise<GitCredentialView> {
    const existing = await this.prisma.gitCredential.findUnique({ where: { id } });
    if (!existing || existing.revokedAt !== null) {
      this.throwNotFound(id);
    }
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const dup = await this.prisma.gitCredential.findUnique({
        where: { name: dto.name },
        select: { id: true, revokedAt: true },
      });
      if (dup && dup.id !== id && dup.revokedAt === null) {
        throw new ConflictException({
          code: GIT_REPOS_ERRORS.CREDENTIAL_NAME_EXISTS,
          message: `凭证名称 ${dto.name} 已存在`,
        });
      }
      (data as any).name = dto.name;
    }
    if (dto.key !== undefined) {
      (data as any).credentialRef = this.crypto.encrypt(dto.key);
      (data as any).fingerprint = this.crypto.fingerprint(dto.key);
    }
    if (dto.description !== undefined) {
      (data as any).description = dto.description;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.gitCredential.update({ where: { id }, data: data as any });
      this.logger.log(`凭证更新：id=${id} fields=${Object.keys(data).join(',')}`);
    }
    return this.findView(id);
  }

  async remove(id: string, userId: string): Promise<{ id: string; revokedAt: Date }> {
    const existing = await this.prisma.gitCredential.findUnique({ where: { id } });
    if (!existing || existing.revokedAt !== null) {
      this.throwNotFound(id);
    }
    const inUse = await this.prisma.gitRepo.findFirst({
      where: { credentialId: id, revokedAt: null },
      select: { id: true },
    });
    if (inUse) {
      throw new ConflictException({
        code: GIT_REPOS_ERRORS.CREDENTIAL_IN_USE,
        message: `凭证 ${existing.name} 仍被仓库引用，无法删除`,
      });
    }
    const now = new Date();
    await this.prisma.gitCredential.update({ where: { id }, data: { revokedAt: now } });
    this.logger.log(`凭证吊销：name=${existing.name} by=${userId}`);
    return { id, revokedAt: now };
  }

  private async findView(id: string): Promise<GitCredentialView> {
    const row = await this.prisma.gitCredential.findUnique({ where: { id } });
    if (!row) this.throwNotFound(id);
    return this.toView(row);
  }

  private toView(row: GitCredential): GitCredentialView {
    return {
      id: row.id,
      name: (row as any).name,
      authType: row.authType,
      fingerprint: row.fingerprint,
      description: (row as any).description ?? null,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  private throwNotFound(id: string): never {
    throw new NotFoundException({
      code: GIT_REPOS_ERRORS.CREDENTIAL_NOT_FOUND,
      message: `凭证 ${id} 不存在或已吊销`,
    });
  }
}
