import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { UPLOAD_ERRORS } from './uploads.constants';
import {
  FileStorageService,
  StoredFile,
  UploadedFileMeta,
} from './uploads.service';

/**
 * 通用文件上传端点（平台文件存储基础，FILE-01/02、UX-10 共享）。
 * - POST /api/v1/uploads（multipart，字段 file）→ 201 `{url, name, size, ext}`
 * - 缺 file → 400 `UPLOAD_FILE_REQUIRED`
 * - 扩展名不在白名单 → 400 `UPLOAD_FILE_TYPE_NOT_ALLOWED`（fileFilter 拦截）
 * - 超过 10MB → 413（multer limits，与 skills 上传同款机制）
 * - 可选 multipart 字段 taskId：存在时落盘后同步归档为 file 产出物（与 Agent MCP
 *   submit_artifact 上传链路一致，进文档库）；归档失败仅 warn 不阻断上传成功返回。
 * 鉴权：全局 JwtAuthGuard（APP_GUARD）兜底认证——登录用户即可上传
 * （背景文档 / 产出物 / 群聊附件均为普通成员能力；后续如需按资源收口可加权限守卫）。
 */
@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);

  constructor(
    private readonly uploadsService: FileStorageService,
    private readonly artifactsService: ArtifactsService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', FileStorageService.buildMulterOptions()),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            '待上传文件（白名单扩展名：pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt，上限 10MB）',
        },
        taskId: {
          type: 'string',
          description:
            '可选：关联任务 id，存在时落盘后同步归档为 file 产出物（进文档库）',
        },
      },
    },
  })
  @ApiOperation({
    summary:
      '通用文件上传（diskStorage 落盘，UUID 文件名，返回 /uploads 可访问 URL；带 taskId 时同步归档）',
  })
  async upload(
    @UploadedFile() file: StoredFile | undefined,
    @Body() body: { taskId?: string },
  ) {
    if (!file) {
      throw new BadRequestException({
        code: UPLOAD_ERRORS.FILE_REQUIRED,
        message: '缺少 file 文件（multipart 字段名 file）',
      });
    }
    const meta = this.uploadsService.describe(file);
    if (body?.taskId) {
      await this.archiveForTask(body.taskId, file, meta).catch((err) => {
        this.logger.warn(
          `上传归档失败（附件照常返回）: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return meta;
  }

  /** 带 taskId 上传 → 读落盘文件计算 sha256 → 归档为 file 产出物（与 Agent 上传同链路）。
   *  fileRef 存落盘 URL（=消息 attachmentUrl）：read_file 归档命中按 filePath 归一化匹配，
   *  Agent 用 chat_history 返回的 attachmentUrl 可直接读回归档内容。 */
  private async archiveForTask(
    taskId: string,
    file: StoredFile,
    meta: UploadedFileMeta,
  ): Promise<void> {
    const buffer = await readFile(file.path);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await this.artifactsService.archiveFile(taskId, {
      fileRef: meta.url,
      storedUrl: meta.url,
      storedName: file.originalname,
      sha256,
    });
  }
}
