import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/** POST /auth/reset-password 请求体（UX-12：一次性 token 换新密码） */
export class ResetPasswordDto {
  @ApiProperty({ description: '忘记密码接口返回的一次性重置 token' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({
    description: '新密码（对齐 RegisterDto：>= 6 位）',
    example: 'newpass123',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(128)
  newPassword: string;
}
