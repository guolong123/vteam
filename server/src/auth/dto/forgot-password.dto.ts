import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** POST /auth/forgot-password 请求体（UX-12：按用户名或邮箱申请重置 token） */
export class ForgotPasswordDto {
  @ApiProperty({
    description: '账号：用户名或邮箱（二者任一命中即视为本人）',
    example: 'alice',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  account: string;
}
