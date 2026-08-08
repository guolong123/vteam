import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** POST /users/:id/reset-password 请求体（Phase 3 T8 重置密码）。 */
export class ResetPasswordDto {
  @ApiProperty({ description: '新明文密码，bcrypt 哈希后覆盖', example: 'NewPass@123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(128)
  newPassword: string;
}
