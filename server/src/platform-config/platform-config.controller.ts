import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../users/admin.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { UpdatePlatformConfigDto, UpdatePlatformConfigsDto } from './dto/update-platform-config.dto';
import { PlatformConfigService } from './platform-config.service';

/**
 * 平台配置端点（会话上下文压缩等运行期可调参数）。
 *
 * ## 鉴权
 *
 * 平台配置是**系统级**参数（影响所有会话的压缩行为），与「角色权限矩阵」无关，
 * 故挂 **AdminGuard**（`users:manage`），与 stats/overview 同规格——只有平台
 * 管理员可读可改。
 *
 * 全局 JwtAuthGuard（APP_GUARD）兜底：未带 token ⇒ 401。
 *
 * ## 路由
 *
 * - `GET /platform-configs`：全量列表（含默认值兜底，按常量顺序输出）
 * - `GET /platform-configs/:key`：单项（白名单外 → 400 PLATFORM_CONFIG_UNKNOWN_KEY）
 * - `PATCH /platform-configs/:key`：改单项（值校验失败 → 400，不落库）
 * - `PATCH /platform-configs`：批量改（单事务，任一非法 → 整体回滚）
 */
@ApiTags('platform-configs')
@ApiBearerAuth()
@Controller('platform-configs')
export class PlatformConfigController {
  constructor(private readonly configs: PlatformConfigService) {}

  @Get()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '平台配置全量列表（含默认值兜底）' })
  findAll() {
    return this.configs.findAll();
  }

  @Get(':key')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '平台配置单项（未知键 → 400）' })
  findOne(@Param('key') key: string) {
    return this.configs.findOne(key);
  }

  @Patch(':key')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '更新平台配置单项（值校验失败 → 400，不落库）' })
  updateOne(
    @Param('key') key: string,
    @Body() dto: UpdatePlatformConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.configs.updateOne(key, dto.value, user?.id ?? null);
  }

  @Patch()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '批量更新平台配置（单事务，任一非法 → 整体回滚）' })
  updateMany(
    @Body() dto: UpdatePlatformConfigsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.configs.updateMany(dto.configs ?? {}, user?.id ?? null);
  }
}
