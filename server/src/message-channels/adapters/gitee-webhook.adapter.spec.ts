import * as crypto from 'crypto';
import { GiteeWebhookAdapter } from './gitee-webhook.adapter';
import { INTEGRATIONS_ERRORS } from '../message-channel.constants';

describe('GiteeWebhookAdapter', () => {
  let adapter: GiteeWebhookAdapter;
  const secret = 'gitee-secret-token';
  const channel: any = {
    id: 'mc_0000000003',
    type: 'gitee_webhook',
    config: {},
    secrets: { token: secret },
    enabled: true,
  };

  beforeEach(() => {
    adapter = new GiteeWebhookAdapter();
  });

  it('type gitee_webhook and supportsInbound only', () => {
    expect(adapter.type).toBe('gitee_webhook');
    expect(adapter.supportsInbound).toBe(true);
    expect((adapter as any).sendOutbound).toBeUndefined();
  });

  describe('verifyInbound — X-Gitee-Token', () => {
    it('correct token passes', async () => {
      const rawBody = Buffer.from('{"action":"push"}', 'utf-8');
      const req: any = {
        headers: { 'x-gitee-token': secret },
        rawBody,
        body: { action: 'push' },
      };
      await expect(
        adapter.verifyInbound(req, channel),
      ).resolves.toBeUndefined();
    });

    it('bad token throws 401', async () => {
      const rawBody = Buffer.from('{}', 'utf-8');
      const req: any = {
        headers: { 'x-gitee-token': 'bad-token' },
        rawBody,
        body: {},
      };
      await expect(adapter.verifyInbound(req, channel)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        }),
      });
    });

    it('missing token throws 401', async () => {
      const rawBody = Buffer.from('{}', 'utf-8');
      await expect(
        adapter.verifyInbound({ headers: {}, rawBody, body: {} }, channel),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        }),
      });
    });
  });

  describe('normalizeInbound', () => {
    function makeReq(body: any, event: string): any {
      const rawBody = Buffer.from(JSON.stringify(body), 'utf-8');
      return { headers: { 'x-gitee-event': event }, rawBody, body };
    }

    it('push hook default mapping', async () => {
      const body = {
        project: { path_with_namespace: 'owner/repo' },
        pusher: { name: 'ZhangSan' },
        commits: [{ message: 'commit msg' }],
        sender: { login: 'zhangsan' },
      };
      const req = makeReq(body, 'Push Hook');
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).text).toBe('[owner/repo] ZhangSan: commit msg');
      expect((cmds[0] as any).senderName).toBe('ZhangSan');
    });

    it('Issue Hook default mapping', async () => {
      const body = {
        project: { path_with_namespace: 'owner/repo' },
        sender: { login: 'alice' },
        issue: { title: 'Gitee issue' },
      };
      const req = makeReq(body, 'Issue Hook');
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).text).toBe('[owner/repo] alice: Gitee issue');
    });

    it('custom fieldMapping overrides default', async () => {
      const ch: any = {
        ...channel,
        config: {
          fieldMapping: {
            content: '{{ custom.content }}',
            source: 'gitee',
            user: '{{ user.name }}',
          },
        },
      };
      const body = {
        custom: { content: 'my gitee content' },
        user: { name: 'Li' },
      };
      const req = makeReq(body, 'Push Hook');
      const cmds = await adapter.normalizeInbound(req, ch);
      expect((cmds[0] as any).text).toBe('[gitee] Li: my gitee content');
    });

    it('dedupKey sha1 fallback', async () => {
      const body = {
        project: { path_with_namespace: 'owner/repo' },
        sender: { login: 'alice' },
        action: 'open',
      };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf-8');
      const expected = crypto.createHash('sha1').update(rawBody).digest('hex');
      const req: any = {
        headers: { 'x-gitee-event': 'Issue Hook' },
        rawBody,
        body,
      };
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).dedupKey).toBe(expected);
    });
  });
});
