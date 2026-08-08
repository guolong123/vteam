import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * 项目模块（FR-25 基础版：列表 / 创建）。
 * PrismaService 由全局 PrismaModule 提供，无需重复导入。
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
