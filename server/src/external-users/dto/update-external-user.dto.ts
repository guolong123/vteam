import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * PATCH /external-users/:id 请求体（契约 §2.3）：全部可选，只更新传入字段。
 *
 * 语义：空串（或 null）视为**清空** → 服务层存 null（前端表单清空即「未填写」）。
 * 这些是人工维护的管理字段；name 未填时列表/详情用渠道 displayName 作为展示名。
 * displayName/externalId/source 不在可改范围（身份键与入站自动维护字段）。
 */
export class UpdateExternalUserDto {
  @ApiPropertyOptional({ description: '姓名（≤64；空串=清空）', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string | null;

  @ApiPropertyOptional({ description: '岗位（≤64；空串=清空）', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  position?: string | null;

  @ApiPropertyOptional({
    description: '所属公司（≤128；空串=清空）',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  company?: string | null;

  @ApiPropertyOptional({
    description: '联系方式（≤191；空串=清空）',
    maxLength: 191,
  })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  contact?: string | null;
}
