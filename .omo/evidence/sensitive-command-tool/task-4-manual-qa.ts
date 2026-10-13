/**
 * sensitive-command-tool todo 4 手工 QA：真实 HTTP 监听（临时端口）打 /secret-command。
 * 原始输出由外层 shell 重定向进 task-4-worker-route.txt。
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ExecServer } from '../../../worker/src/exec/exec-server';

const SENTINEL = 's3cr3t-A9f';
const TOKEN = 'qa-worker-token';

const logs: string[] = [];
const capture = (level: string) => (m: unknown) => {
  logs.push(String(m));
  console.log(`  [worker-log:${level}] ${String(m)}`);
};
const logger = {
  info: capture('info'),
  warn: capture('warn'),
  error: capture('error'),
};

interface CallResult {
  status: number;
  raw: string;
  ms: number;
}

async function call(
  port: number,
  opts: { method?: string; token?: string; raw?: string; body?: unknown } = {},
): Promise<CallResult> {
  const data =
    opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(data)),
  };
  if (opts.token !== undefined) {
    headers['X-Worker-Token'] = opts.token;
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/secret-command',
        method: opts.method ?? 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw: Buffer.concat(chunks).toString('utf8'),
            ms: Date.now() - started,
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function report(label: string, res: CallResult): void {
  console.log(
    `>>> ${label}\n    HTTP ${res.status} (${res.ms}ms)\n    BODY ${res.raw || '(empty)'}`,
  );
}

async function main(): Promise<void> {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't4-qa-')));
  const hitFile = path.join(workDir, 'idem-hits.txt');
  console.log(`workDir=${workDir}`);

  const exec = new ExecServer({
    port: 0,
    driver: {} as never,
    sender: { send: async () => undefined } as never,
    workerToken: TOKEN,
    workDir,
    maxBodyBytes: 2048,
    logger,
  });
  const bound = await exec.start();
  console.log(`listening on 127.0.0.1:${bound} (ephemeral port)\n`);

  const responses: string[] = [];
  const record = (label: string, res: CallResult): CallResult => {
    responses.push(res.raw);
    report(label, res);
    console.log('');
    return res;
  };

  try {
    const payload = {
      requestId: 'req_qa_1',
      taskId: 't_qa_1',
      sessionId: 'ses_qa_1',
      commandTemplate: 'echo {{TOKEN}} && echo {{TOKEN}} >&2 && echo run >> idem-hits.txt',
      secrets: { TOKEN: SENTINEL },
      timeoutMs: 30000,
    };

    record('A. wrong method (GET) + valid token -> expect 405',
      await call(bound, { method: 'GET', token: TOKEN }));
    record('B. POST without token -> expect 401',
      await call(bound, { body: payload }));
    record('C. POST with wrong token -> expect 401',
      await call(bound, { token: 'wrong-token', body: payload }));
    record('D. POST with right token (sentinel secret) -> expect 200',
      await call(bound, { token: TOKEN, body: payload }));
    record('E. same requestId + same ownership -> expect 200 replay (byte-identical)',
      await call(bound, { token: TOKEN, body: payload }));
    record('F. same requestId + different taskId -> expect 409',
      await call(bound, {
        token: TOKEN,
        body: { ...payload, taskId: 't_qa_other', commandTemplate: 'echo pwned >> idem-hits.txt' },
      }));
    record('G. malformed JSON -> expect 400',
      await call(bound, { token: TOKEN, raw: '{not-json' }));
    record('H. oversize body (> 2048 bytes) -> expect 413',
      await call(bound, {
        token: TOKEN,
        body: { ...payload, requestId: 'req_qa_big', commandTemplate: `echo ${'x'.repeat(4096)}` },
      }));
    record('I. hung command with timeoutMs=500 -> expect 200 {status:"timeout"}',
      await call(bound, {
        token: TOKEN,
        body: { ...payload, requestId: 'req_qa_timeout', commandTemplate: 'sleep 30', timeoutMs: 500 },
      }));
    record('J. cwd escape ../../etc -> expect 400 fixed message',
      await call(bound, {
        token: TOKEN,
        body: { ...payload, requestId: 'req_qa_cwd', commandTemplate: 'id', cwd: '../../etc' },
      }));

    const hits = fs.existsSync(hitFile)
      ? fs.readFileSync(hitFile, 'utf8').split('\n').filter((l) => l.length > 0).length
      : 0;
    console.log(`>>> I1. side-effect executions (idem-hits.txt lines) = ${hits} (expect 1)\n`);

    const joinedResponses = responses.join('\n');
    const responseHits = joinedResponses.split(SENTINEL).length - 1;
    const logHits = logs.join('\n').split(SENTINEL).length - 1;
    const bodyHits = logs.join('\n').split('commandTemplate').length - 1;
    console.log('=== SENTINEL SCAN (s3cr3t-A9f) ===');
    console.log(`hits in ${responses.length} HTTP response bodies : ${responseHits} (expect 0)`);
    console.log(`hits in ${logs.length} worker log lines          : ${logHits} (expect 0)`);
    console.log(`'commandTemplate' occurrences in worker logs     : ${bodyHits} (expect 0)`);
    console.log(
      `rendered command "echo s3cr3t" in responses      : ${
        joinedResponses.split('echo s3cr3t').length - 1
      } (expect 0)`,
    );
    console.log(
      `"cwd" key in responses                          : ${
        joinedResponses.split('"cwd"').length - 1
      } (expect 0)`,
    );
  } finally {
    await exec.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('QA SCRIPT FAILED:', err);
  process.exitCode = 1;
});
