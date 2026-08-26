import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { AdminGuard } from './admin.guard';

/**
 * 用户管理端点（09 篇 §3.2，FR-22）。
 * Phase 1：列表 / 详情 / 禁用启用；Phase 3 T8：创建 / 重置密码（挂 AdminGuard）。
 */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({ summary: '创建用户（含角色分配，Phase 3 T8）' })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: '用户分页列表（不含 password_hash）' })
  findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    return this.usersService.findAll(
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
      search,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: '用户详情' })
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '禁用/启用用户（FR-22）' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateUserStatusDto) {
    return this.usersService.updateStatus(id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新用户信息（用户名/邮箱/角色，ISSUE-002 修复）' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }

  @Post(':id/reset-password')
  @ApiOperation({ summary: '重置用户密码（Phase 3 T8）' })
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.usersService.resetPassword(id, dto);
  }
}
