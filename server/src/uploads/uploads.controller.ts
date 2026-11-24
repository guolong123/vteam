import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UnauthorizedException,
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
import { CurrentWorkspace } from '../common/decorators/current-workspace.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
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
 * - 类型不限：任意扩展名 / 无扩展名文件均放行（能否读取由模型自行判断处理，
 *   如 zip 由模型解压；控制面不设类型白名单）
 * - 超过 20MB → 413（multer limits，与 skills 上传同款机制）
 * - 静态下载（GET /uploads/*）统一带 `Content-Disposition: attachment` 强制下载 +
 *   nosniff + CSP sandbox，杜绝上传的 .html/.svg 在本源内联执行
 * - 可选 multipart 字段 taskId：存在时落盘后同步归档为 file 产出物（与 Agent MCP
 *   submit_artifact 上传链路一致，进文档库）；归档失败仅 warn 不阻断上传成功返回。
 * - M0 止血：带 taskId 时**归档前**先做归属校验（task → team → team_user_members）：
 *   任务不存在 404、调用者非团队成员 403 PERMISSION_TEAM_NOT_MEMBER——否则任何登录
 *   用户都能把文件写进别人任务的产出物库。归属校验失败直接拒绝上传请求（不静默降级）。
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
            '待上传文件（任意扩展名/无扩展名均可，不做类型白名单；上限 20MB）',
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
    @CurrentUser() user?: AuthenticatedUser,
    @CurrentWorkspace() tenant?: TenantContext,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: UPLOAD_ERRORS.FILE_REQUIRED,
        message: '缺少 file 文件（multipart 字段名 file）',
      });
    }
    // M2：URL 带空间段（文件已由 multer destination 落盘到该空间目录）。
    const meta = this.uploadsService.describe(file, tenant?.workspaceId);
    if (body?.taskId) {
      // M0：归档前校验任务归属团队且调用者为成员（失败即拒，不静默跳过归档）
      await this.assertTaskMember(body.taskId, user?.id);
      await this.archiveForTask(body.taskId, file, meta).catch((err) => {
        this.logger.warn(
          `上传归档失败（附件照常返回）: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return meta;
  }

  /** 归属校验：调用方身份缺失 → 401；任务不存在/非成员由 ArtifactsService.assertTaskMember 抛错（404/403）。 */
  private async assertTaskMember(
    taskId: string,
    userId: string | undefined,
  ): Promise<void> {
    if (!userId) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '未认证或 token 无效',
      });
    }
    await this.artifactsService.assertTaskMember(taskId, userId);
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
      // 用 meta.name（已修复 latin1/UTF-8 错位）而非 file.originalname：中文文件名
      // 否则会以乱码形态进产出物库（与上传响应/DTO 口径保持一致）。
      storedName: meta.name,
      sha256,
    });
  }
}
