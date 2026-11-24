import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type { WorkspaceSummary } from '../workspaces/workspaces.constants';
import { AUTH_ERRORS, BUILTIN_ROLES, JWT_TOKEN_TYPE } from './auth.constants';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';

const BCRYPT_ROUNDS = 10;
/** 重置 token 有效期（30 分钟，内网手动传递可接受） */
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** 登录/刷新成功返回的用户摘要（不含 password_hash） */
export interface AuthUserView {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  roleId: string;
  roleName: string;
  enabled: boolean;
  /**
   * 角色权限（对齐 PermissionGuard 语义：`{all:true}` / `{all:false}` / 完整矩阵
   * `{[resource]: {[action]: boolean}}`，见 users/roles.constants.ts）。
   * 前端导航过滤 / 路由守卫以此为数据源（ISSUE-005）。
   */
  permissions: Record<string, unknown>;
  /** 当前工作空间 id（登录/刷新/切换空间时解析） */
  currentWorkspaceId?: string | null;
  /** 我可访问的工作空间列表（含系统空间，isSystem=true） */
  workspaces?: WorkspaceSummary[];
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** POST /auth/register：创建内置账号（默认角色 member，无项目） */
  async register(dto: RegisterDto) {
    const { username, password, displayName, email } = dto;

    const existingByUsername = await this.prisma.user.findUnique({
      where: { username },
    });
    if (existingByUsername) {
      throw new ConflictException({
        code: AUTH_ERRORS.USERNAME_CONFLICT,
        message: `用户名 ${username} 已被占用`,
      });
    }
    if (email) {
      const existingByEmail = await this.prisma.user.findUnique({
        where: { email },
      });
      if (existingByEmail) {
        throw new ConflictException({
          code: AUTH_ERRORS.EMAIL_CONFLICT,
          message: `邮箱 ${email} 已被占用`,
        });
      }
    }

    const memberRole = await this.prisma.role.findUnique({
      where: { name: BUILTIN_ROLES.MEMBER },
    });
    if (!memberRole) {
      throw new ConflictException({
        code: 'ROLE_NOT_FOUND',
        message: `内置角色 ${BUILTIN_ROLES.MEMBER} 未初始化，请先执行 seed`,
      });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: {
        id: `u_${Date.now()}`,
        username,
        passwordHash,
        displayName,
        email,
        roleId: memberRole.id,
        enabled: true,
      },
    });

    // 每个新用户一个个人空间（owner）。失败不阻断注册：登录/首次请求会自愈创建。
    try {
      await this.workspaces.createForUser(
        user.id,
        `${user.displayName || user.username} 的空间`,
      );
    } catch {
      // 空间创建失败不回滚账号；resolveOrCreateDefault 会在首次登录时补建
    }

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
    };
  }

  /** POST /auth/login：校验凭证并签发 access+refresh token */
  async login(dto: LoginDto): Promise<{
    accessToken: string;
    refreshToken: string;
    user: AuthUserView;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
      include: { role: true },
    });
    if (!user) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.INVALID_CREDENTIALS,
        message: '用户名或密码错误',
      });
    }
    if (!user.enabled) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.DISABLED,
        message: '该账号已被禁用',
      });
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.INVALID_CREDENTIALS,
        message: '用户名或密码错误',
      });
    }

    const workspaceId = await this.workspaces.resolveOrCreateDefault(user.id);
    const tokens = await this.signTokens(
      user.id,
      user.username,
      user.roleId,
      workspaceId,
    );
    return {
      ...tokens,
      user: await this.buildUserView(user, workspaceId),
    };
  }

  /** GET /auth/profile：返回当前登录用户资料（JWT 已鉴权） */
  async profile(
    userId: string,
    currentWorkspaceId?: string,
  ): Promise<AuthUserView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.UNAUTHORIZED,
        message: '用户不存在',
      });
    }
    const workspaceId =
      currentWorkspaceId &&
      (await this.workspaces.canAccess(userId, currentWorkspaceId))
        ? currentWorkspaceId
        : await this.workspaces.resolveOrCreateDefault(userId);
    return this.buildUserView(user, workspaceId);
  }

  /**
   * POST /auth/workspace：切换当前空间（校验成员关系后重签 token）。
   * 前端切换空间 = 调本接口换新 access/refresh token。
   */
  async switchWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<TokenPair & { user: AuthUserView }> {
    await this.workspaces.switchTo(userId, workspaceId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.UNAUTHORIZED,
        message: '用户不存在',
      });
    }
    const tokens = await this.signTokens(
      user.id,
      user.username,
      user.roleId,
      workspaceId,
    );
    return { ...tokens, user: await this.buildUserView(user, workspaceId) };
  }

  /** POST /auth/refresh：校验 refresh token 并签发新 token 对 */
  async refresh(dto: RefreshDto): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(dto.refreshToken, {
        secret: this.config.get<string>('JWT_SECRET') ?? 'dev-secret',
      });
    } catch {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.REFRESH_INVALID,
        message: 'refresh token 无效或已过期',
      });
    }
    if (payload.type !== JWT_TOKEN_TYPE.REFRESH) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.REFRESH_INVALID,
        message: 'refresh token 无效',
      });
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.enabled) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.REFRESH_INVALID,
        message: '账号不存在或已禁用',
      });
    }
    const workspaceId =
      payload.wid && (await this.workspaces.canAccess(user.id, payload.wid))
        ? payload.wid
        : await this.workspaces.resolveOrCreateDefault(user.id);
    return this.signTokens(user.id, user.username, user.roleId, workspaceId);
  }

  /** POST /auth/forgot-password：按用户名/邮箱生成一次性重置 token（内网手动传递，无邮件服务） */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{
    resetToken: string;
    expiresAt: Date;
  }> {
    let user = await this.prisma.user.findUnique({
      where: { username: dto.account },
    });
    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { email: dto.account },
      });
    }
    if (!user) {
      throw new NotFoundException({
        code: AUTH_ERRORS.USER_NOT_FOUND,
        message: '账号不存在',
      });
    }

    const resetToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { resetToken, resetTokenExpires: expiresAt },
    });
    return { resetToken, expiresAt };
  }

  /** POST /auth/reset-password：校验一次性 token 并重置密码（成功后清除 token） */
  async resetPassword(dto: ResetPasswordDto): Promise<{ ok: true }> {
    const user = await this.prisma.user.findFirst({
      where: { resetToken: dto.token },
    });
    if (
      !user ||
      !user.resetTokenExpires ||
      user.resetTokenExpires.getTime() < Date.now()
    ) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.RESET_TOKEN_INVALID,
        message: '重置 token 无效或已过期',
      });
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetToken: null, resetTokenExpires: null },
    });
    return { ok: true };
  }

  /** 签发 access（短时效，默认 2h）+ refresh（默认 7d） */
  private async signTokens(
    sub: string,
    username: string,
    roleId: string,
    workspaceId?: string,
  ): Promise<TokenPair> {
    const secret = this.config.get<string>('JWT_SECRET') ?? 'dev-secret';
    const accessExpiresIn =
      this.config.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '2h';
    const refreshExpiresIn =
      this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '7d';

    const base = {
      sub,
      username,
      roleId,
      ...(workspaceId ? { wid: workspaceId } : {}),
    };
    const accessToken = await this.jwt.signAsync(
      { ...base, type: JWT_TOKEN_TYPE.ACCESS },
      { secret, expiresIn: accessExpiresIn as any },
    );
    const refreshToken = await this.jwt.signAsync(
      { ...base, type: JWT_TOKEN_TYPE.REFRESH },
      { secret, expiresIn: refreshExpiresIn as any },
    );
    return { accessToken, refreshToken };
  }

  /** 用户视图 + 当前空间 + 空间列表（登录/刷新/profile 共用）。 */
  private async buildUserView(
    user: Parameters<AuthService['toUserView']>[0],
    currentWorkspaceId: string,
  ): Promise<AuthUserView> {
    return {
      ...this.toUserView(user),
      currentWorkspaceId,
      workspaces: await this.workspaces.listForUser(user.id),
    };
  }

  private toUserView(user: {
    id: string;
    username: string;
    displayName: string;
    email?: string;
    roleId: string;
    enabled: boolean;
    role: { name: string; permissions?: unknown };
  }): AuthUserView {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      roleId: user.roleId,
      roleName: user.role.name,
      enabled: user.enabled,
      // 旧数据 role.permissions 可能缺失 → 空对象兜底（前端按「无权限」处理）
      permissions: (user.role.permissions ?? {}) as Record<string, unknown>,
    };
  }
}
