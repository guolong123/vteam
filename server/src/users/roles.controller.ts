import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from './admin.guard';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RolesService } from './roles.service';

/**
 * 角色矩阵端点（Phase 3 T8，挂 AdminGuard）。
 * GET /roles 列表；POST 自定义角色；PATCH/DELETE 预置角色（admin/member）403。
 */
@ApiTags('roles')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiOperation({ summary: '角色列表（含 permissions/scopes）' })
  findAll() {
    return this.rolesService.findAll();
  }

  @Post()
  @ApiOperation({ summary: '创建自定义角色' })
  create(@Body() dto: CreateRoleDto) {
    return this.rolesService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新自定义角色（预置角色 403）' })
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.rolesService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除自定义角色（预置角色 403，被引用 409）' })
  remove(@Param('id') id: string) {
    return this.rolesService.remove(id);
  }
}
