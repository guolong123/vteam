/**
 * Task 8 evidence harness (vteam-role-behavior-abstraction):
 * HTTP-level proof that PATCH /execution-policies/:id now edits built-in
 * (`type='template'`) policies, while POST type=template and DELETE stay 403.
 *
 * Real Nest application (ExecutionPoliciesController + real ExecutionPolicyService)
 * + supertest, with an in-memory PrismaService stub (NO DB connection). The global
 * ValidationPipe is applied exactly as main.ts does, so DTO semantics are real.
 *
 * Usage (from anywhere; server/ has ts-node):
 *   node capture-task8-patch.mjs
 *
 * Output: task-8-patch.txt (next to this script). Exit code != 0 if a claim fails.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '../../../server');
const serverRequire = createRequire(join(SERVER_ROOT, 'package.json'));

serverRequire('ts-node').register({
  transpileOnly: true,
  project: join(SERVER_ROOT, 'tsconfig.json'),
  compilerOptions: {
    module: 'commonjs',
    target: 'ES2021',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
  },
});
serverRequire('reflect-metadata');

const { ValidationPipe } = serverRequire('@nestjs/common');
const { Test } = serverRequire('@nestjs/testing');
const request = serverRequire('supertest');
const { APP_GUARD } = serverRequire('@nestjs/core');
const { PermissionGuard } = serverRequire(
  join(SERVER_ROOT, 'src/common/guards/permission.guard.ts'),
);

const {
  ExecutionPoliciesController,
} = serverRequire(
  join(SERVER_ROOT, 'src/execution-policies/execution-policies.controller.ts'),
);
const {
  ExecutionPolicyService,
} = serverRequire(
  join(SERVER_ROOT, 'src/execution-policies/execution-policy.service.ts'),
);
const { PrismaService } = serverRequire(
  join(SERVER_ROOT, 'src/prisma/prisma.service.ts'),
);
const { IdGeneratorService } = serverRequire(
  join(SERVER_ROOT, 'src/common/id-generator.ts'),
);

const ROLE_CONFIG = {
  permission: {
    edit: { '*': 'deny' },
    read: { '*': 'allow' },
    bash: 'allow',
    task: 'deny',
    vteam_group_post: 'deny',
  },
  correction: { scopeSummary: 'scope', handoff: {}, denyTemplate: 't' },
  tools: { vteam_group_post: 'allow', vteam_memory_search: 'allow' },
};

function makeDb() {
  const rows = new Map();
  rows.set('ep_product', {
    id: 'ep_product',
    name: '产品经理策略',
    description: 'seed builtin',
    type: 'template',
    config: JSON.parse(JSON.stringify(ROLE_CONFIG)),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  });
  let seq = 1;
  const prisma = {
    __rows: rows,
    user: {
      findUnique: () =>
        Promise.resolve({
          id: 'u_spec',
          enabled: true,
          role: { permissions: { all: true } },
        }),
    },
    executionPolicy: {
      findUnique: ({ where }) => Promise.resolve(rows.get(where.id) ?? null),
      findMany: ({ where }) =>
        Promise.resolve(
          where?.id?.in
            ? where.id.in.map((id) => rows.get(id)).filter(Boolean)
            : [...rows.values()],
        ),
      create: ({ data }) => {
        const row = {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(row.id, row);
        return Promise.resolve(row);
      },
      update: ({ where, data }) => {
        const row = { ...rows.get(where.id), ...data, updatedAt: new Date() };
        rows.set(where.id, row);
        return Promise.resolve(row);
      },
      delete: ({ where }) => {
        const row = rows.get(where.id);
        rows.delete(where.id);
        return Promise.resolve(row);
      },
      count: () => Promise.resolve(rows.size),
    },
  };
  const idGen = { nextId: () => Promise.resolve(`ep_${String(seq++).padStart(10, '0')}`) };
  return { prisma, idGen };
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail !== undefined) console.log(`      ${detail}`);
}

async function main() {
  const { prisma, idGen } = makeDb();
  const moduleRef = await Test.createTestingModule({
    controllers: [ExecutionPoliciesController],
    providers: [
      ExecutionPolicyService,
      PermissionGuard,
      { provide: APP_GUARD, useClass: PermissionGuard },
      { provide: PrismaService, useValue: prisma },
      { provide: IdGeneratorService, useValue: idGen },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.use((req, _res, next) => {
    req.user = { id: 'u_spec' };
    next();
  });
  await app.init();
  const http = request(app.getHttpServer());

  // ---- (1) PATCH a built-in policy's config.tools -> 200 and persists ----
  const nextTools = {
    vteam_group_post: 'deny',
    vteam_memory_search: 'ask',
    vteam_notify_agent: 'deny',
  };
  const patchRes = await http
    .patch('/execution-policies/ep_product')
    .send({
      config: { ...ROLE_CONFIG, tools: nextTools },
    });
  record(
    'PATCH /execution-policies/ep_product (type=template) -> 200',
    patchRes.status === 200,
    `status=${patchRes.status} body=${JSON.stringify(patchRes.body).slice(0, 220)}`,
  );
  record(
    'PATCH response carries the edited tools',
    JSON.stringify(patchRes.body?.config?.tools) === JSON.stringify(nextTools),
    JSON.stringify(patchRes.body?.config?.tools),
  );

  const getRes = await http.get('/execution-policies/ep_product');
  record(
    'GET /execution-policies/ep_product -> 200 with persisted change',
    getRes.status === 200 &&
      JSON.stringify(getRes.body?.config?.tools) === JSON.stringify(nextTools),
    `status=${getRes.status} persisted.tools=${JSON.stringify(getRes.body?.config?.tools)}`,
  );
  record(
    'GET round-trip still type=template (type immutable)',
    getRes.body?.type === 'template',
    `type=${getRes.body?.type}`,
  );

  // ---- (2) POST type=template cannot forge a template row ----
  // Layer 1 (wire): DTO @IsIn(['custom']) rejects with 400 before the service.
  // Layer 2 (service): the create() template guard still throws 403
  //   POLICY_TEMPLATE_READONLY (kept intact; asserted via the controller spec
  //   passthrough at execution-policies.controller.spec.ts:111-127).
  const templateRowsBefore = [...prisma.__rows.values()].filter(
    (r) => r.type === 'template',
  ).length;
  const postRes = await http.post('/execution-policies').send({
    name: 'forged template',
    type: 'template',
    config: ROLE_CONFIG,
  });
  const templateRowsAfter = [...prisma.__rows.values()].filter(
    (r) => r.type === 'template',
  ).length;
  record(
    "HTTP POST type=template rejected at DTO layer (400 'must be one of custom') and forges NO row",
    postRes.status === 400 && templateRowsAfter === templateRowsBefore,
    `status=${postRes.status} message=${JSON.stringify(postRes.body?.message)} rows_before=${templateRowsBefore} rows_after=${templateRowsAfter}`,
  );
  const policyService = moduleRef.get(ExecutionPolicyService);
  let servicePostError = null;
  try {
    await policyService.create({
      name: 'forged template direct',
      type: 'template',
      config: ROLE_CONFIG,
    });
  } catch (e) {
    servicePostError = e;
  }
  record(
    'service.create(type=template) STILL -> 403 POLICY_TEMPLATE_READONLY (defense in depth)',
    servicePostError?.getStatus?.() === 403 &&
      servicePostError?.getResponse?.()?.code === 'POLICY_TEMPLATE_READONLY',
    `status=${servicePostError?.getStatus?.()} code=${servicePostError?.getResponse?.()?.code} message=${servicePostError?.getResponse?.()?.message}`,
  );

  // ---- (3) DELETE built-in -> 403 POLICY_TEMPLATE_READONLY ----
  const delRes = await http.delete('/execution-policies/ep_product');
  record(
    'DELETE built-in STILL -> 403 POLICY_TEMPLATE_READONLY',
    delRes.status === 403 && delRes.body?.code === 'POLICY_TEMPLATE_READONLY',
    `status=${delRes.status} code=${delRes.body?.code} message=${delRes.body?.message}`,
  );
  record(
    'built-in row survives the rejected DELETE',
    prisma.__rows.has('ep_product'),
    `row_present=${prisma.__rows.has('ep_product')}`,
  );

  // ---- (4) control: custom POST still works (201) ----
  const customRes = await http.post('/execution-policies').send({
    name: 'custom ok',
    type: 'custom',
    config: ROLE_CONFIG,
  });
  record(
    'POST type=custom (control) -> 201',
    customRes.status === 201 && customRes.body?.type === 'custom',
    `status=${customRes.status} id=${customRes.body?.id}`,
  );

  // ---- (5) failure path: invalid config rejected (400) on BOTH layers ----
  // Wire layer: DTO PolicyConfigDto requires permission+correction objects.
  const badRes = await http
    .patch('/execution-policies/ep_product')
    .send({ config: { permission: 'deny' } });
  record(
    'HTTP PATCH template with invalid config -> 400 (DTO PolicyConfigDto)',
    badRes.status === 400,
    `status=${badRes.status} message=${JSON.stringify(badRes.body?.message)}`,
  );
  // Service layer: assertValidConfig throws 400 POLICY_CONFIG_INVALID.
  let serviceBadError = null;
  try {
    await policyService.update('ep_product', {
      config: { permission: 'deny' },
    });
  } catch (e) {
    serviceBadError = e;
  }
  record(
    'service.update invalid config -> 400 POLICY_CONFIG_INVALID',
    serviceBadError?.getStatus?.() === 400 &&
      serviceBadError?.getResponse?.()?.code === 'POLICY_CONFIG_INVALID',
    `status=${serviceBadError?.getStatus?.()} code=${serviceBadError?.getResponse?.()?.code}`,
  );
  const afterBad = await http.get('/execution-policies/ep_product');
  record(
    'rejected invalid PATCH left the persisted config untouched',
    JSON.stringify(afterBad.body?.config?.tools) === JSON.stringify(nextTools),
    `persisted.tools=${JSON.stringify(afterBad.body?.config?.tools)}`,
  );

  await app.close();

  const allPass = results.every((r) => r.pass);
  const lines = [
    'task-8-patch — PATCH built-in policy allowed, POST/DELETE template stay 403',
    `plan: vteam-role-behavior-abstraction Todo 8`,
    `run_at: ${new Date().toISOString()}`,
    'method: real Nest TestingModule (ExecutionPoliciesController + real ExecutionPolicyService)',
    '        + supertest + global ValidationPipe; PrismaService stubbed in-memory (no DB)',
    '',
    ...results.map(
      (r) =>
        `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`,
    ),
    '',
    `allPass: ${allPass}`,
  ];
  writeFileSync(join(HERE, 'task-8-patch.txt'), `${lines.join('\n')}\n`);
  console.log(`\nallPass: ${allPass}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
