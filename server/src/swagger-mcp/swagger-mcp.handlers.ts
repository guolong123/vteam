import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { HealthCheckService } from '@nestjs/terminus';
import { AgentsService } from '../agents/agents.service';
import { QueryAgentsDto } from '../agents/dto/query-agents.dto';
import { UpdateAgentDto } from '../agents/dto/update-agent.dto';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { QueryArtifactsDto } from '../artifacts/dto/artifact.dto';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { CreateMcpServerDto } from '../mcp-servers/dto/create-mcp-server.dto';
import { QueryMcpServersDto } from '../mcp-servers/dto/query-mcp-servers.dto';
import { UpdateMcpServerDto } from '../mcp-servers/dto/update-mcp-server.dto';
import { CreateModelDto } from '../models/dto/create-model.dto';
import { QueryModelsDto } from '../models/dto/query-models.dto';
import { SetModelCredentialDto } from '../models/dto/set-model-credential.dto';
import { UpdateModelDto } from '../models/dto/update-model.dto';
import { ModelsService } from '../models/models.service';
import { QuerySkillsDto } from '../skills/dto/query-skills.dto';
import { UpdateSkillDto } from '../skills/dto/update-skill.dto';
import { SkillsService } from '../skills/skills.service';
import { QueryTasksDto } from '../tasks/dto/query-tasks.dto';
import { UpdateTaskDto } from '../tasks/dto/update-task.dto';
import { TasksService } from '../tasks/tasks.service';
import { CreateToolDto } from '../tools/dto/create-tool.dto';
import { QueryToolsDto } from '../tools/dto/query-tools.dto';
import { UpdateToolDto } from '../tools/dto/update-tool.dto';
import { ToolsService } from '../tools/tools.service';
import { CreateRoleDto } from '../users/dto/create-role.dto';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { ResetPasswordDto } from '../users/dto/reset-password.dto';
import { UpdateRoleDto } from '../users/dto/update-role.dto';
import { UpdateUserDto } from '../users/dto/update-user.dto';
import { UpdateUserStatusDto } from '../users/dto/update-user-status.dto';
import { RolesService } from '../users/roles.service';
import { UsersService } from '../users/users.service';
import { DEFAULT_WORKER_TOKEN } from '../workers/workers.constants';
import { UpdateWorkerModelDto } from '../workers/dto/update-worker-model.dto';
import { WorkersService } from '../workers/workers.service';
import type { SwaggerMcpTool } from './swagger-tools';

/** handler 上下文：workerId 透传（权限与归属校验在 controller/auth 内完成）。 */
export interface SwaggerMcpHandlerContext {
  workerId: string;
}

/** 工具入参（ajv 已按 inputSchema 校验通过的扁平对象：path/query/body 合并）。 */
export type SwaggerMcpArgs = Record<string, unknown>;

export interface HttpRef {
  method: string;
  path: string;
}

/**
 * 工具 → service 调用映射条目（阶段 2 任务 11）。
 * - match：按 httpRef（method+path）精确命中；
 * - taskIdOf：从 args 提取归属校验用 taskId（缺省跳过归属校验——无 taskId 的管理面
 *   工具由权限点默认 deny 兜底）；
 * - call：调用对应 service 方法，参数透传 args（与 DTO 字段同名）。
 */
export interface SwaggerMcpHandler {
  match: (httpRef: HttpRef) => boolean;
  taskIdOf?: (args: SwaggerMcpArgs) => string | undefined;
  call: (
    ctx: SwaggerMcpHandlerContext,
    args: SwaggerMcpArgs,
  ) => Promise<unknown>;
}

/** args → DTO 类型断言（ajv 已校验，字段与 DTO 同名）。 */
const asDto = <T>(args: SwaggerMcpArgs): T => args as unknown as T;

/** 匹配层路径归一化：剥离全局前缀 /api/v1（main.ts setGlobalPrefix 注入 Swagger paths 键，httpRef.path 保持原始形态便于调试）。 */
const stripGlobalPrefix = (p: string): string =>
  p.replace(/^\/api\/v1(?=\/|$)/, '');

const upperFirst = (s: string): string =>
  s ? s[0].toUpperCase() + s.slice(1) : s;

/**
 * 解析 sanitize 后 operationId（形如 `taskscontroller_findall`）：
 * 首段 = controller 基名（去 `controller` 后缀），后续段拼接 = 方法名。
 * 不满足 `<controller>_<method>` 形态返回 undefined（交由 NOT_IMPLEMENTED）。
 */
function parseOperationId(
  name: string,
): { baseName: string; methodName: string } | undefined {
  const parts = name.split('_').filter((p) => p.length > 0);
  if (parts.length < 2) return undefined;
  const base = parts[0].replace(/controller$/i, '');
  if (base === '') return undefined;
  return { baseName: base, methodName: parts.slice(1).join('') };
}

/** 方法名规范化：小写 + 去非字母数字（findAll / find_all / findall 视为等价）。 */
const normalizeMethodName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** 在 service 实例上按方法名查找（不区分大小写、忽略分隔符）；原型 + 自有属性都覆盖。 */
function findServiceMethod(
  service: unknown,
  methodName: string,
): ((...args: unknown[]) => unknown) | undefined {
  const target = normalizeMethodName(methodName);
  const record = service as Record<string, unknown>;
  const names: string[] = [];
  const proto = Object.getPrototypeOf(record) as Record<string, unknown> | null;
  if (proto) names.push(...Object.getOwnPropertyNames(proto));
  for (const key of Object.keys(record)) {
    if (!names.includes(key)) names.push(key);
  }
  for (const name of names) {
    if (name === 'constructor') continue;
    if (normalizeMethodName(name) !== target) continue;
    const fn = record[name];
    if (typeof fn === 'function') return fn as (...args: unknown[]) => unknown;
  }
  return undefined;
}

/**
 * handler 绑定（阶段 2 任务 11）：Swagger 工具 → service 方法映射。
 *
 * 覆盖原则：绑定**能从 args 完整提供参数**的业务 API（GET 读操作为主 + 无需用户
 * 身份的后台方法）。需用户 JWT 上下文的写操作（tasks/chat/issues 的 create/start/
 * 发消息等）不在本表——agent 场景无 userId，由权限点默认 deny 兜底 + platform-mcp
 * 既有 agent 专用工具（chat_history/issue_*）覆盖；未命中映射的工具由 controller
 * 返回 NOT_IMPLEMENTED。
 *
 * taskId 归属校验：/tasks/{id}、/tasks/{id}/artifacts 等参数即任务 id 的工具，
 * 调用前经 taskIdOf 提取并走 auth.assertWorkerTask（该 worker 有绑定会话）。
 */
@Injectable()
export class SwaggerMcpHandlers {
  constructor(
    private readonly tasks: TasksService,
    private readonly artifacts: ArtifactsService,
    private readonly agents: AgentsService,
    private readonly workers: WorkersService,
    private readonly models: ModelsService,
    private readonly skills: SkillsService,
    private readonly tools: ToolsService,
    private readonly mcpServers: McpServersService,
    private readonly users: UsersService,
    private readonly roles: RolesService,
    private readonly health: HealthCheckService,
    private readonly config: ConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly discovery: DiscoveryService,
  ) {}

  build(): readonly SwaggerMcpHandler[] {
    const m = (method: string, path: string) => (httpRef: HttpRef) =>
      httpRef.method === method && stripGlobalPrefix(httpRef.path) === path;
    /** path 参数即 taskId 的提取（/tasks/{id}、/tasks/{id}/artifacts 等）。 */
    const taskIdFromArgs = (args: SwaggerMcpArgs): string | undefined =>
      typeof args.id === 'string' ? args.id : undefined;

    return [
      // ---- tasks（TasksService：读 + 编辑，写状态流转需 userId 不绑定） ----
      {
        match: m('get', '/projects/{pid}/tasks'),
        call: (_, args) =>
          this.tasks.findAll(String(args.pid), asDto<QueryTasksDto>(args)),
      },
      {
        match: m('get', '/tasks/{id}'),
        taskIdOf: taskIdFromArgs,
        call: (_, args) => this.tasks.findOne(String(args.id)),
      },
      {
        match: m('patch', '/tasks/{id}'),
        taskIdOf: taskIdFromArgs,
        call: (_, args) =>
          this.tasks.update(String(args.id), asDto<UpdateTaskDto>(args)),
      },

      // ---- artifacts（ArtifactsService） ----
      {
        match: m('get', '/tasks/{id}/artifacts'),
        taskIdOf: taskIdFromArgs,
        call: (_, args) =>
          this.artifacts.findByTask(
            String(args.id),
            asDto<QueryArtifactsDto>(args),
          ),
      },
      {
        match: m('post', '/tasks/{id}/artifacts'),
        taskIdOf: taskIdFromArgs,
        call: (_, args) =>
          this.artifacts.append(String(args.id), {
            taskId: String(args.id),
            type: String(args.type),
            title: String(args.title),
            content: typeof args.content === 'string' ? args.content : '',
            fileRef:
              typeof args.fileRef === 'string' ? args.fileRef : undefined,
          }),
      },
      {
        match: m('get', '/artifacts/{id}'),
        call: (_, args) => this.artifacts.findOne(String(args.id)),
      },
      {
        match: m('get', '/artifacts/{id}/versions/{version}'),
        call: (_, args) =>
          this.artifacts.findVersion(String(args.id), Number(args.version)),
      },

      // ---- agents（AgentsService，GET 为主 + update/remove 无需 userId） ----
      {
        match: m('get', '/agents'),
        call: (_, args) => this.agents.findAll(asDto<QueryAgentsDto>(args)),
      },
      {
        match: m('get', '/agents/{id}'),
        call: (_, args) => this.agents.findOne(String(args.id)),
      },
      {
        match: m('get', '/agents/{id}/available-models'),
        call: (_, args) => this.agents.getAvailableModels(String(args.id)),
      },
      {
        match: m('patch', '/agents/{id}'),
        call: (_, args) =>
          this.agents.update(String(args.id), asDto<UpdateAgentDto>(args)),
      },
      {
        match: m('delete', '/agents/{id}'),
        call: (_, args) => this.agents.remove(String(args.id)),
      },

      // ---- workers（WorkersService，管理面；register/heartbeat 需 workerToken 不绑定） ----
      {
        match: m('get', '/workers'),
        call: () => this.workers.findAll(),
      },
      {
        match: m('get', '/workers/register-token'),
        call: async () => ({
          token: this.config.get<string>('WORKER_TOKEN', DEFAULT_WORKER_TOKEN),
        }),
      },
      {
        match: m('get', '/workers/{id}'),
        call: (_, args) => this.workers.findOne(String(args.id)),
      },
      {
        match: m('patch', '/workers/{id}'),
        call: (_, args) =>
          this.workers.updateDefaultModel(
            String(args.id),
            asDto<UpdateWorkerModelDto>(args),
          ),
      },
      {
        match: m('post', '/workers/{id}/restart'),
        call: (_, args) => this.workers.requestRestart(String(args.id)),
      },
      {
        match: m('post', '/workers/{id}/shutdown'),
        call: (_, args) => this.workers.requestShutdown(String(args.id)),
      },
      {
        match: m('delete', '/workers/{id}'),
        call: (_, args) => this.workers.remove(String(args.id)),
      },

      // ---- models（ModelsService） ----
      {
        match: m('get', '/models'),
        call: (_, args) => this.models.findAll(asDto<QueryModelsDto>(args)),
      },
      {
        match: m('get', '/models/providers'),
        call: () => this.models.listProviders(),
      },
      {
        match: m('get', '/models/{id}'),
        call: (_, args) => this.models.findOne(String(args.id)),
      },
      {
        match: m('post', '/models'),
        call: (_, args) => this.models.create(asDto<CreateModelDto>(args)),
      },
      {
        match: m('patch', '/models/{id}'),
        call: (_, args) =>
          this.models.update(String(args.id), asDto<UpdateModelDto>(args)),
      },
      {
        match: m('delete', '/models/{id}'),
        call: (_, args) => this.models.remove(String(args.id)),
      },
      {
        match: m('post', '/models/{id}/credentials'),
        call: (_, args) => {
          const dto = asDto<SetModelCredentialDto>(args);
          return this.models.setCredential(
            String(args.id),
            dto.token,
            dto.providerID,
            dto.targetWorkerIds,
          );
        },
      },
      {
        match: m('get', '/models/{id}/credentials'),
        call: (_, args) => this.models.getCredential(String(args.id)),
      },
      {
        match: m('delete', '/models/{id}/credentials'),
        call: (_, args) => this.models.revokeCredential(String(args.id)),
      },
      {
        match: m('delete', '/models/providers/{providerID}/credentials'),
        call: (_, args) =>
          this.models.revokeCredentialByProvider(String(args.providerID)),
      },

      // ---- skills（SkillsService；create 走 multipart 上传不绑定） ----
      {
        match: m('get', '/skills'),
        call: (_, args) => this.skills.findAll(asDto<QuerySkillsDto>(args)),
      },
      {
        match: m('get', '/skills/{id}/content'),
        call: (_, args) => this.skills.findContent(String(args.id)),
      },
      {
        match: m('patch', '/skills/{id}'),
        call: (_, args) =>
          this.skills.update(String(args.id), asDto<UpdateSkillDto>(args)),
      },
      {
        match: m('patch', '/skills/{id}/status'),
        call: (_, args) =>
          this.skills.updateStatus(String(args.id), args.enabled === true),
      },

      // ---- tools（ToolsService） ----
      {
        match: m('get', '/tools'),
        call: (_, args) => this.tools.findAll(asDto<QueryToolsDto>(args)),
      },
      {
        match: m('post', '/tools'),
        call: (_, args) => this.tools.create(asDto<CreateToolDto>(args)),
      },
      {
        match: m('patch', '/tools/{id}'),
        call: (_, args) =>
          this.tools.update(String(args.id), asDto<UpdateToolDto>(args)),
      },

      // ---- mcp-servers（McpServersService） ----
      {
        match: m('get', '/mcp-servers'),
        call: (_, args) =>
          this.mcpServers.findAll(asDto<QueryMcpServersDto>(args)),
      },
      {
        match: m('get', '/mcp-servers/{id}'),
        call: (_, args) => this.mcpServers.findOne(String(args.id)),
      },
      {
        match: m('post', '/mcp-servers'),
        call: (_, args) =>
          this.mcpServers.create(asDto<CreateMcpServerDto>(args)),
      },
      {
        match: m('patch', '/mcp-servers/{id}'),
        call: (_, args) =>
          this.mcpServers.update(
            String(args.id),
            asDto<UpdateMcpServerDto>(args),
          ),
      },
      {
        match: m('delete', '/mcp-servers/{id}'),
        call: (_, args) => this.mcpServers.remove(String(args.id)),
      },

      // ---- users / roles（UsersService / RolesService，管理面） ----
      {
        match: m('get', '/users'),
        call: (_, args) =>
          this.users.findAll(
            args.page !== undefined ? Number(args.page) : 1,
            args.pageSize !== undefined ? Number(args.pageSize) : 20,
            typeof args.search === 'string' ? args.search : undefined,
          ),
      },
      {
        match: m('get', '/users/{id}'),
        call: (_, args) => this.users.findOne(String(args.id)),
      },
      {
        match: m('post', '/users'),
        call: (_, args) => this.users.create(asDto<CreateUserDto>(args)),
      },
      {
        match: m('patch', '/users/{id}/status'),
        call: (_, args) =>
          this.users.updateStatus(
            String(args.id),
            asDto<UpdateUserStatusDto>(args),
          ),
      },
      {
        match: m('patch', '/users/{id}'),
        call: (_, args) =>
          this.users.update(String(args.id), asDto<UpdateUserDto>(args)),
      },
      {
        match: m('post', '/users/{id}/reset-password'),
        call: (_, args) =>
          this.users.resetPassword(
            String(args.id),
            asDto<ResetPasswordDto>(args),
          ),
      },
      {
        match: m('get', '/roles'),
        call: () => this.roles.findAll(),
      },
      {
        match: m('post', '/roles'),
        call: (_, args) => this.roles.create(asDto<CreateRoleDto>(args)),
      },
      {
        match: m('patch', '/roles/{id}'),
        call: (_, args) =>
          this.roles.update(String(args.id), asDto<UpdateRoleDto>(args)),
      },
      {
        match: m('delete', '/roles/{id}'),
        call: (_, args) => this.roles.remove(String(args.id)),
      },

      // ---- health（Terminus 健康检查） ----
      {
        match: m('get', '/health'),
        call: () => this.health.check([]),
      },
    ];
  }

  /**
   * 约定式自动绑定兜底：手动映射（build()）未命中时，从 operationId
   * （sanitize 后小写，形如 `skillscontroller_create`）反推 controller 基名 +
   * 方法名，获取对应 service 实例并返回 handler。解析失败返回 undefined →
   * controller 走 NOT_IMPLEMENTED（与现状一致）。
   */
  autoHandler(tool: SwaggerMcpTool): SwaggerMcpHandler | undefined {
    const parsed = parseOperationId(tool.name);
    if (!parsed) return undefined;
    const service = this.resolveService(parsed.baseName);
    if (service === undefined || service === null) return undefined;
    const method = findServiceMethod(service, parsed.methodName);
    if (!method) return undefined;
    return {
      // controller 直接调用本 handler，不参与 match 分发。
      match: () => false,
      call: (_ctx, args) => {
        try {
          return Promise.resolve(method.call(service, args));
        } catch (err) {
          return Promise.reject(err);
        }
      },
    };
  }

  /** service 解析：先按 `${Base}Service` 字符串 token 经 ModuleRef 取，失败则 DiscoveryService 全局扫描按实例构造名匹配。 */
  private resolveService(baseName: string): unknown {
    const token = `${upperFirst(baseName)}Service`;
    try {
      const byToken = this.moduleRef.get(token, { strict: false });
      if (byToken !== undefined && byToken !== null) return byToken;
    } catch {
      // 类 token 注册的 provider 用字符串 token 查找会抛 UnknownElementException，走 Discovery 兜底。
    }
    for (const wrapper of this.discovery.getProviders()) {
      const inst = wrapper?.instance;
      if (
        inst &&
        (inst as { constructor?: { name?: string } }).constructor?.name === token
      ) {
        return inst;
      }
    }
    return undefined;
  }
}
