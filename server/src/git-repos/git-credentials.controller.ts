import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, AuthenticatedUser } from '../projects/current-user.decorator';
import { AdminGuard } from '../users/admin.guard';
import { CreateGitCredentialDto } from './dto/create-git-credential.dto';
import { UpdateGitCredentialDto } from './dto/update-git-credential.dto';
import { GitCredentialsService } from './git-credentials.service';

@ApiTags('git-credentials')
@ApiBearerAuth()
@Controller('git-credentials')
export class GitCredentialsController {
  constructor(private readonly svc: GitCredentialsService) {}

  @Get()
  @ApiOperation({ summary: '凭证池列表（脱敏，成员只读）' })
  findAll() {
    return this.svc.findAll();
  }

  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '创建凭证（AES-256-GCM 加密存储，AdminGuard）' })
  create(@Body() dto: CreateGitCredentialDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.create(dto, user.id);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '更新凭证（部分更新，AdminGuard）' })
  update(@Param('id') id: string, @Body() dto: UpdateGitCredentialDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.update(id, dto, user.id);
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '软撤销凭证（被引用则 409，AdminGuard）' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.remove(id, user.id);
  }
}
