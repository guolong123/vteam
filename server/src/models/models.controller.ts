import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../users/admin.guard';
import { SetModelCredentialDto } from './dto/set-model-credential.dto';
import { ModelsService } from './models.service';

/**
 * 模型凭据管理端点（C4，17 篇 §3.4 安全基线）。
 * 全局 JwtAuthGuard（APP_GUARD）已鉴权：
 * - POST/DELETE（写操作）挂 AdminGuard（token 属敏感信息，仅管理员可写）；
 * - GET（成员只读）不挂 AdminGuard——只返回脱敏 fingerprint，无明文敏感信息。
 * 全局前缀 /api/v1（main.ts 已设置），实际路由 /api/v1/models/:id/credentials。
 * 模块 CRUD（模型目录管理）属 C3，本控制器当前只承载凭据端点。
 */
@ApiTags('models')
@ApiBearerAuth()
@Controller('models')
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  /**
   * 保存模型 provider token（AES-256-GCM 加密存储）。
   * POST /api/v1/models/:id/credentials {token, providerID?} → 201 + {id, providerID, configured, fingerprint, revokedAt, createdAt}
   *   model 不存在 → 404；body.providerID 与 model 不一致 → 400；同 provider 重复 POST 覆盖更新（幂等）。
   */
  @Post(':id/credentials')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '保存模型 provider 凭据（AES-256-GCM 加密存储）' })
  setCredential(
    @Param('id') id: string,
    @Body() dto: SetModelCredentialDto,
  ) {
    return this.modelsService.setCredential(id, dto.token, dto.providerID);
  }

  /**
   * 查询凭据状态（脱敏，成员只读）。
   * GET /api/v1/models/:id/credentials → 200 + {configured, fingerprint, revokedAt, createdAt}
   *   绝不返回明文 token（明文零接触）。
   */
  @Get(':id/credentials')
  @ApiOperation({ summary: '查询模型凭据状态（仅脱敏 fingerprint，无明文）' })
  getCredential(@Param('id') id: string) {
    return this.modelsService.getCredential(id);
  }

  /**
   * 吊销凭据（软撤销）。
   * DELETE /api/v1/models/:id/credentials → 200 + 脱敏视图（revokedAt 已置）
   *   凭据不存在 → 404 MODEL_CREDENTIAL_NOT_FOUND。
   */
  @Delete(':id/credentials')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '吊销模型凭据（revokedAt 软撤销）' })
  revokeCredential(@Param('id') id: string) {
    return this.modelsService.revokeCredential(id);
  }
}
