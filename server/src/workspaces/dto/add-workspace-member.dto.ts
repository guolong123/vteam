import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { WORKSPACE_ROLE } from '../workspaces.constants';

/** POST /workspaces/:id/members 请求体。 */
export class AddWorkspaceMemberDto {
  @ApiProperty({ description: '目标用户 id', example: 'u_0000000002' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiPropertyOptional({
    description:
      '空间内角色：owner/admin/member（默认 member；owner 不可通过邀请产生）',
    enum: [WORKSPACE_ROLE.ADMIN, WORKSPACE_ROLE.MEMBER],
  })
  @IsOptional()
  @IsIn([WORKSPACE_ROLE.ADMIN, WORKSPACE_ROLE.MEMBER])
  role?: string;
}
