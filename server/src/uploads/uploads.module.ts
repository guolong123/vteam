import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { UploadsController } from './uploads.controller';
import { FileStorageService } from './uploads.service';

/**
 * 上传模块（平台文件存储基础能力，FILE-01/02、UX-10 共享）。
 * - POST /api/v1/uploads：通用文件上传（diskStorage 落盘 server/uploads/，静态 /uploads/* 可达）；
 *   可选 multipart taskId → 落盘后经 ArtifactsService.archiveFile 同步归档（与 Agent 上传链路一致）。
 * - FileStorageService 全局可注入：后续上传消费方（背景文档/产出物/群聊附件）复用
 *   buildMulterOptions（装饰器）/ describe（响应元数据）
 * - ArtifactsModule 导出 ArtifactsService（archiveFile 公共归档）；ArtifactsModule 仅依赖
 *   RealtimeModule，无环。
 * 无其它数据库/事件依赖（纯文件系统 + 静态服务，main.ts 挂载）。
 */
@Module({
  imports: [ArtifactsModule],
  controllers: [UploadsController],
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class UploadsModule {}
