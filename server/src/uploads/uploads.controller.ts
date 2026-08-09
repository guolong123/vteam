import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UPLOAD_ERRORS } from './uploads.constants';
import { FileStorageService, StoredFile } from './uploads.service';

/**
 * 通用文件上传端点（平台文件存储基础，FILE-01/02、UX-10 共享）。
 * - POST /api/v1/uploads（multipart，字段 file）→ 201 `{url, name, size, ext}`
 * - 缺 file → 400 `UPLOAD_FILE_REQUIRED`
 * - 扩展名不在白名单 → 400 `UPLOAD_FILE_TYPE_NOT_ALLOWED`（fileFilter 拦截）
 * - 超过 10MB → 413（multer limits，与 skills 上传同款机制）
 * 鉴权：全局 JwtAuthGuard（APP_GUARD）兜底认证——登录用户即可上传
 * （背景文档 / 产出物 / 群聊附件均为普通成员能力；后续如需按资源收口可加权限守卫）。
 */
@ApiTags('uploads')
@ApiBearerAuth()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: FileStorageService) {}

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
          description: '待上传文件（白名单扩展名：pdf/doc/docx/xls/xlsx/csv/png/jpg/jpeg/gif/md/txt，上限 10MB）',
        },
      },
    },
  })
  @ApiOperation({
    summary: '通用文件上传（diskStorage 落盘，UUID 文件名，返回 /uploads 可访问 URL）',
  })
  upload(@UploadedFile() file: StoredFile | undefined) {
    if (!file) {
      throw new BadRequestException({
        code: UPLOAD_ERRORS.FILE_REQUIRED,
        message: '缺少 file 文件（multipart 字段名 file）',
      });
    }
    return this.uploadsService.describe(file);
  }
}
