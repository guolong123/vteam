import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MEMBER_STATUS } from '../members.constants';

/** PATCH /members/:id 请求体：全部可选，仅更新传入字段。 */
export class UpdateMemberDto {
  @ApiPropertyOptional({ description: '成员名（全局唯一）', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '默认岗位 id（AgentRole）' })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({ description: '执行 Agent id' })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({ description: '默认模型 id' })
  @IsOptional()
  @IsString()
  defaultModelId?: string;

  @ApiPropertyOptional({ description: '默认 worker 偏好' })
  @IsOptional()
  @IsString()
  preferredWorkerId?: string;

  @ApiPropertyOptional({ description: '成员私有工作目录', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  privateWorkDir?: string;

  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: '状态：active / disabled',
    enum: ['active', 'disabled'],
  })
  @IsOptional()
  @IsIn([MEMBER_STATUS.active, MEMBER_STATUS.disabled])
  status?: string;
}
