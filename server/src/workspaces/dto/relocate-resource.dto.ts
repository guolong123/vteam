import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { RELOCATABLE_RESOURCE_TYPES } from '../workspaces.constants';

/** POST /workspaces/relocations：把资源迁移到另一个空间（含系统空间=发布共享/回收）。 */
export class RelocateResourceDto {
  @ApiProperty({
    description: '资源类型（仅配置/能力类资源可迁移）',
    enum: RELOCATABLE_RESOURCE_TYPES,
    example: 'agent',
  })
  @IsIn([...RELOCATABLE_RESOURCE_TYPES])
  resourceType: string;

  @ApiProperty({ description: '资源 id', example: 'a_0000000001' })
  @IsString()
  @IsNotEmpty()
  resourceId: string;

  @ApiProperty({
    description:
      '目标空间 id。目标为系统空间（ws_system）= 发布为平台共享；从系统空间移出 = 回收共享（先做依赖检查）。',
    example: 'ws_system',
  })
  @IsString()
  @IsNotEmpty()
  targetWorkspaceId: string;

  @ApiPropertyOptional({ description: '迁移原因（审计展示）', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
