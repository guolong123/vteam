import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../users/admin.guard';
import { CreateModelDto } from './dto/create-model.dto';
import { QueryModelsDto } from './dto/query-models.dto';
import { UpdateModelDto } from './dto/update-model.dto';
import { SetModelCredentialDto } from './dto/set-model-credential.dto';
import { ModelsService } from './models.service';

/**
 * 模型目录管理端点（C3 CRUD + C4 凭据，17 篇 §3.4 安全基线）。
 * 全局 JwtAuthGuard（APP_GUARD）已鉴权：
 * - POST/PATCH/DELETE（写操作）挂 AdminGuard；
 * - GET（成员只读）不挂 AdminGuard——目录/凭据状态只读可见。
 * 全局前缀 /api/v1（main.ts 已设置），实际路由 /api/v1/models。
 */
@ApiTags('models')
@ApiBearerAuth()
@Controller('models')
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  /**
   * 目录列表（enabled 过滤 + providerID/modelID/name 搜索 + 分页，成员只读）。
   * GET /api/v1/models?enabled=true&providerID=opencode&name=deepseek&page=1&pageSize=20
   *   → 200 {items, total, page, pageSize}
   */
  @Get()
  @ApiOperation({ summary: '模型目录列表（enabled 过滤 + 搜索 + 分页，成员只读）' })
  findAll(@Query() query: QueryModelsDto) {
    return this.modelsService.findAll(query);
  }

  /**
   * Provider 聚合列表（Provider 页数据源，成员只读）。
   * GET /api/v1/models/providers → 200 + Array<{providerID, modelCount, configured, fingerprint, revokedAt}>
   *   providerID 来自 models 表聚合（已有模型归属的 provider）；modelCount = enabled 模型数；
   *   configured = ModelCredential 存在且未 revoked；fingerprint 仅脱敏指纹（无明文）。
   *   声明在 :id 之前——NestJS 路由按声明顺序匹配，静态段必须先于参数段。
   */
  @Get('providers')
  @ApiOperation({ summary: 'Provider 聚合列表（模型数 + 凭据状态，成员只读）' })
  listProviders() {
    return this.modelsService.listProviders();
  }

  /** GET /api/v1/models/:id → 200 + Model；不存在 → 404 MODEL_NOT_FOUND。 */
  @Get(':id')
  @ApiOperation({ summary: '模型目录详情' })
  findOne(@Param('id') id: string) {
    return this.modelsService.findOne(id);
  }

  /**
   * 创建目录条目（AdminGuard）。
   * POST /api/v1/models {providerID, modelID, name, capabilities?, enabled?} → 201 + Model
   *   providerID+modelID 撞唯一 → 409 MODEL_EXISTS
   */
  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '创建模型目录条目（AdminGuard）' })
  create(@Body() dto: CreateModelDto) {
    return this.modelsService.create(dto);
  }

  /**
   * 编辑/启停目录条目（部分更新，AdminGuard）。
   * PATCH /api/v1/models/:id {enabled: false, name?, ...} → 200 + Model
   *   不存在 → 404；改 providerID/modelID 撞唯一 → 409
   */
  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '更新模型目录条目（编辑/启停，部分更新，AdminGuard）' })
  update(@Param('id') id: string, @Body() dto: UpdateModelDto) {
    return this.modelsService.update(id, dto);
  }

  /**
   * 删除目录条目（物理删除，AdminGuard）。
   * DELETE /api/v1/models/:id → 200；不存在 → 404 MODEL_NOT_FOUND
   *   先清理该模型的 WorkerModelAvailability（FK onDelete Restrict）再删 model。
   */
  @Delete(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '删除模型目录条目（物理删除，清理 availability，AdminGuard）' })
  remove(@Param('id') id: string) {
    return this.modelsService.remove(id);
  }

  /**
   * 保存模型 provider token（AES-256-GCM 加密存储）。
   * POST /api/v1/models/:id/credentials {token, providerID?, targetWorkerIds?} → 201 + 脱敏视图
   *   model 不存在 → 404；body.providerID 与 model 不一致 → 400；同 provider 重复 POST 覆盖更新（幂等）；
   *   targetWorkerIds 非空 → 凭据定向下发到指定 worker；空 → 全量广播。
   */
  @Post(':id/credentials')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '保存模型 provider 凭据（AES-256-GCM 加密存储 + C5 下发）' })
  setCredential(
    @Param('id') id: string,
    @Body() dto: SetModelCredentialDto,
  ) {
    return this.modelsService.setCredential(
      id,
      dto.token,
      dto.providerID,
      dto.targetWorkerIds,
    );
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
