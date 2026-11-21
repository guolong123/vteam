import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

/**
 * GET /models 查询参数（enabled 过滤 + providerID/modelID/name 模糊搜索 + 分页，
 * 对齐 QueryMcpServersDto 模式，返回 {items, total, page, pageSize}）。
 */
export class QueryModelsDto extends PaginatedQueryDto {
  @ApiPropertyOptional({
    description: '启用状态过滤（true 仅启用 / false 仅停用），缺省返回全部',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsIn([true, false])
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      '仅返回「可用」模型：至少一个在线 worker 上报过 availability（下拉选择用）',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true || value === '1' || value === 1)
      return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsIn([true, false])
  available?: boolean;

  @ApiPropertyOptional({ description: 'providerID 模糊搜索（contains）' })
  @IsOptional()
  @IsString()
  providerID?: string;

  @ApiPropertyOptional({ description: 'modelID 模糊搜索（contains）' })
  @IsOptional()
  @IsString()
  modelID?: string;

  @ApiPropertyOptional({ description: 'name 模糊搜索（contains）' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'provider 类型过滤（cloud|local|custom）',
    enum: ['cloud', 'local', 'custom'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['cloud', 'local', 'custom'])
  providerType?: string;
}
