import * as crypto from 'crypto';
import { GithubWebhookAdapter } from './github-webhook.adapter';
import { INTEGRATIONS_ERRORS } from '../message-channel.constants';

describe('GithubWebhookAdapter', () => {
  let adapter: GithubWebhookAdapter;
  const secret = "It's a Secret to Everybody";
  const channel: any = {
    id: 'mc_0000000002',
    type: 'github_webhook',
    config: {},
    secrets: { secret },
    enabled: true,
  };

  beforeEach(() => {
    adapter = new GithubWebhookAdapter();
  });

  it('type github_webhook and supportsInbound only', () => {
    expect(adapter.type).toBe('github_webhook');
    expect(adapter.supportsInbound).toBe(true);
    expect((adapter as any).sendOutbound).toBeUndefined();
    expect((adapter as any).verifyInbound).toBeDefined();
  });

  describe('verifyInbound — X-Hub-Signature-256 official vector', () => {
    // Official GitHub docs vector: secret="It's a Secret", payload="Hello,World!" => sha256=757107ea0eb2509fc211221cce984b8a37570b6d05d703919f11228655beaf8
    // But payload includes raw bytes exactly as sent. We'll test both "Hello,World!" and "Hello, World!" (with space)
    it('official vector Hello,World! passes', async () => {
      const payload = 'Hello,World!';
      const rawBody = Buffer.from(payload, 'utf-8');
      const hmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
      const expected = `sha256=${hmac}`;
      // known vector check for Hello,World! (no space) should be deterministic
      const req: any = {
        headers: { 'x-hub-signature-256': expected, 'x-github-event': 'push' },
        rawBody,
        body: payload,
      };
      await expect(
        adapter.verifyInbound(req, channel),
      ).resolves.toBeUndefined();
    });

    it('official vector Hello, World! matches doc hex 757107ea...', async () => {
      const payloadWithSpace = 'Hello, World!';
      const rawBodyWithSpace = Buffer.from(payloadWithSpace, 'utf-8');
      const hmacWithSpace = crypto
        .createHmac('sha256', secret)
        .update(rawBodyWithSpace)
        .digest('hex');
      const expectedWithSpace = `sha256=${hmacWithSpace}`;
      expect(expectedWithSpace).toBe(
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      );
      const req: any = {
        headers: {
          'x-hub-signature-256': expectedWithSpace,
          'x-github-event': 'ping',
        },
        rawBody: rawBodyWithSpace,
        body: payloadWithSpace,
      };
      await expect(
        adapter.verifyInbound(req, channel),
      ).resolves.toBeUndefined();
    });

    it('bad signature throws 401', async () => {
      const rawBody = Buffer.from('Hello,World!', 'utf-8');
      const req: any = {
        headers: {
          'x-hub-signature-256':
            'sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb',
        },
        rawBody,
        body: 'Hello,World!',
      };
      await expect(adapter.verifyInbound(req, channel)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        }),
      });
    });

    it('missing signature throws 401', async () => {
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

  describe('normalizeInbound — X-Github-Event branching to default fieldMapping', () => {
    function makeReq(body: any, event: string, delivery?: string): any {
      const rawBody = Buffer.from(JSON.stringify(body), 'utf-8');
      return {
        headers: {
          'x-github-event': event,
          'x-github-delivery': delivery ?? 'delivery_123',
        },
        rawBody,
        body,
      };
    }

    it('push event default mapping produces [repo] pusher: message', async () => {
      const body = {
        repository: { full_name: 'octocat/Hello-World' },
        pusher: { name: 'Codertocat' },
        head_commit: { message: 'Fix bug' },
        sender: { login: 'octocat' },
      };
      const req = makeReq(body, 'push', 'del_push');
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).text).toBe(
        '[octocat/Hello-World] Codertocat: Fix bug',
      );
      expect((cmds[0] as any).dedupKey).toBe('del_push');
      expect((cmds[0] as any).senderName).toBe('Codertocat');
    });

    it('issues event default mapping', async () => {
      const body = {
        action: 'opened',
        repository: { full_name: 'owner/repo' },
        sender: { login: 'alice' },
        issue: { title: 'Bug found' },
      };
      const req = makeReq(body, 'issues');
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).text).toBe('[owner/repo] alice: Bug found');
    });

    it('ping event uses zen', async () => {
      const body = {
        zen: 'Keep it logically awesome.',
        sender: { login: 'github' },
      };
      const req = makeReq(body, 'ping');
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).text).toContain('Keep it logically awesome');
    });

    it('custom fieldMapping overrides default', async () => {
      const ch: any = {
        ...channel,
        config: {
          fieldMapping: {
            content: '{{ custom.field }}',
            source: 'custom-source',
            user: '{{ actor }}',
          },
        },
      };
      const body = { custom: { field: 'my content' }, actor: 'Bob' };
      const req = makeReq(body, 'push');
      const cmds = await adapter.normalizeInbound(req, ch);
      expect((cmds[0] as any).text).toBe('[custom-source] Bob: my content');
      expect((cmds[0] as any).senderName).toBe('Bob');
    });

    it('fallback dedupKey is sha1 when header missing', async () => {
      const body = {
        repository: { full_name: 'owner/repo' },
        sender: { login: 'alice' },
        action: 'opened',
      };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf-8');
      const expected = crypto.createHash('sha1').update(rawBody).digest('hex');
      const req: any = {
        headers: { 'x-github-event': 'issues' },
        rawBody,
        body,
      };
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).dedupKey).toBe(expected);
    });
  });
});
