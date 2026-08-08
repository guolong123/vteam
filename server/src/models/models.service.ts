import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ModelCredential } from '@prisma/client';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { MODEL_ERRORS } from './models.constants';

/** 模型凭据域主键前缀（15 篇 §2.2：`mc_<零填充序号>`，如 mc_0000000001）。 */
const MODEL_CREDENTIAL_ID_PREFIX = 'mc';

/** 凭据对外视图（脱敏：绝不携带 credentialRef 明文，17 篇 §3.4 明文零接触）。 */
export interface ModelCredentialView {
  id: string;
  providerID: string;
  /** 是否已配置凭据（含已吊销——吊销保留 fingerprint 与轨迹）。 */
  configured: boolean;
  /** 脱敏标识（sk-a****89xz）；未配置时为 null。 */
  fingerprint: string | null;
  revokedAt: Date | null;
  createdAt: Date | null;
}

/**
 * 模型凭据服务（C4）：provider token 的 AES-256-GCM 加密存储 + 脱敏查询 + 软吊销。
 *
 * - setCredential：按 model 的 providerID upsert（同 provider 重复 POST 覆盖更新，
 *   幂等决策——覆盖更新更实用）；加密只存 credentialRef，不落明文。
 * - getCredential：只返回 {configured, fingerprint, revokedAt}，绝不返回明文 token。
 * - revokeCredential：软撤销（revokedAt 标记，保留审计轨迹；不物理删除）。
 * - onModuleInit：mc_ 前缀续号（复用通用 resyncIdPrefix，对齐 md_ 模式）。
 *
 * 模块 CRUD（模型目录管理）属 C3，本服务当前只承载凭据端点。
 */
@Injectable()
export class ModelsService implements OnModuleInit {
  private readonly logger = new Logger(ModelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly crypto: CredentialCryptoService,
  ) {}

  /** 进程启动对齐 mc_ 前缀序号（重启续号，对齐 md_/ms_ onModuleInit 模式）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.modelCredential,
      MODEL_CREDENTIAL_ID_PREFIX,
      this.idGen,
    );
  }

  /**
   * POST /models/:id/credentials：加密存储 provider token。
   * - model 不存在 → 404 MODEL_NOT_FOUND；
   * - body.providerID 可选：缺省取 model.providerID；显式提供时须与 model 一致
   *   （校验一致策略，冲突 → 400 MODEL_PROVIDER_MISMATCH，避免 GET 按 model.providerID 查不到）；
   * - 同 providerID 重复 POST → 覆盖更新（credentialRef/fingerprint 替换 + 清除 revokedAt）。
   * 返回脱敏视图（无明文 token）。
   */
  async setCredential(
    modelId: string,
    token: string,
    providerID?: string,
  ): Promise<ModelCredentialView> {
    const modelProviderID = await this.resolveProviderID(modelId);
    if (providerID && providerID.trim().length > 0) {
      if (providerID.trim() !== modelProviderID) {
        throw new BadRequestException({
          code: MODEL_ERRORS.MODEL_PROVIDER_MISMATCH,
          message: `body.providerID=${providerID} 与该模型 providerID=${modelProviderID} 不一致（凭据按 provider 粒度存储）`,
        });
      }
    }
    const credentialRef = this.crypto.encrypt(token);
    const fingerprint = this.crypto.fingerprint(token);

    const existing = await this.prisma.modelCredential.findUnique({
      where: { providerID: modelProviderID },
    });

    let row: ModelCredential;
    if (existing) {
      row = await this.prisma.modelCredential.update({
        where: { providerID: modelProviderID },
        data: { credentialRef, fingerprint, revokedAt: null },
      });
      this.logger.log(
        `模型凭据覆盖更新：model=${modelId} provider=${modelProviderID} fingerprint=${fingerprint}`,
      );
    } else {
      row = await this.prisma.modelCredential.create({
        data: {
          id: await this.idGen.nextId(MODEL_CREDENTIAL_ID_PREFIX),
          providerID: modelProviderID,
          credentialRef,
          fingerprint,
        },
      });
      this.logger.log(
        `模型凭据录入：model=${modelId} provider=${modelProviderID} fingerprint=${fingerprint}`,
      );
    }
    return this.toView(row);
  }

  /**
   * GET /models/:id/credentials：凭据状态查询。
   * 只返回 {configured, fingerprint, revokedAt}——明文零接触，绝不返回 credentialRef/token。
   */
  async getCredential(modelId: string): Promise<ModelCredentialView> {
    const providerID = await this.resolveProviderID(modelId);
    const row = await this.prisma.modelCredential.findUnique({
      where: { providerID },
    });
    if (!row) {
      return {
        id: '',
        providerID,
        configured: false,
        fingerprint: null,
        revokedAt: null,
        createdAt: null,
      };
    }
    return this.toView(row);
  }

  /**
   * DELETE /models/:id/credentials：软撤销（revokedAt 标记，保留审计轨迹）。
   * - 凭据不存在 → 404 MODEL_CREDENTIAL_NOT_FOUND。
   */
  async revokeCredential(modelId: string): Promise<ModelCredentialView> {
    const providerID = await this.resolveProviderID(modelId);
    const existing = await this.prisma.modelCredential.findUnique({
      where: { providerID },
    });
    if (!existing) {
      throw new NotFoundException({
        code: MODEL_ERRORS.MODEL_CREDENTIAL_NOT_FOUND,
        message: `模型 ${modelId}（provider=${providerID}）尚未配置凭据`,
      });
    }
    const row = await this.prisma.modelCredential.update({
      where: { providerID },
      data: { revokedAt: new Date() },
    });
    this.logger.log(
      `模型凭据吊销：model=${modelId} provider=${providerID} fingerprint=${row.fingerprint}`,
    );
    return this.toView(row);
  }

  /** 由 model id 解析 providerID；model 不存在 → 404 MODEL_NOT_FOUND。 */
  private async resolveProviderID(modelId: string): Promise<string> {
    const model = await this.prisma.model.findUnique({
      where: { id: modelId },
      select: { providerID: true },
    });
    if (!model) {
      throw new NotFoundException({
        code: MODEL_ERRORS.MODEL_NOT_FOUND,
        message: `模型 ${modelId} 不存在`,
      });
    }
    return model.providerID;
  }

  /** 行 → 脱敏视图（无 credentialRef）。 */
  private toView(row: ModelCredential): ModelCredentialView {
    return {
      id: row.id,
      providerID: row.providerID,
      configured: true,
      fingerprint: row.fingerprint,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }
}
