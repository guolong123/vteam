import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * 项目模块（FR-25 基础版：列表 / 创建）。
 * PrismaService 由全局 PrismaModule 提供，无需重复导入。
 * PermissionGuard（ISSUE-006 权限矩阵）：POST /projects 挂 projects.create，
 * 本模块注册供编译期解析（依赖全局 PrismaService + Reflector）。
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, PermissionGuard],
})
export class ProjectsModule {}
