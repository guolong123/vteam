import * as crypto from 'crypto';
import { GenericWebhookInboundAdapter } from './generic-webhook-inbound.adapter';
import { INTEGRATIONS_ERRORS } from '../message-channel.constants';

describe('GenericWebhookInboundAdapter', () => {
  let adapter: GenericWebhookInboundAdapter;
  const secret = 'test-secret';
  const channel: any = {
    id: 'mc_0000000001',
    type: 'generic_webhook',
    config: {},
    secrets: { secret },
    enabled: true,
  };

  beforeEach(() => {
    adapter = new GenericWebhookInboundAdapter();
  });

  it('type generic_webhook and supportsInbound', () => {
    expect(adapter.type).toBe('generic_webhook');
    expect(adapter.supportsInbound).toBe(true);
    expect((adapter as any).sendOutbound).toBeUndefined();
  });

  describe('verifyInbound — x-vteam-signature', () => {
    const bodyStr = '{"text":"hello"}';
    const bodyBuf = Buffer.from(bodyStr, 'utf-8');
    function buildReq(signature?: string): any {
      const hmac = crypto
        .createHmac('sha256', secret)
        .update(bodyBuf)
        .digest('hex');
      const sig = signature ?? `sha256=${hmac}`;
      return {
        headers: { 'x-vteam-signature': sig },
        rawBody: bodyBuf,
        body: JSON.parse(bodyStr),
      };
    }
    it('correct signature passes', async () => {
      await expect(
        adapter.verifyInbound(buildReq(), channel),
      ).resolves.toBeUndefined();
    });
    it('bad signature throws 401 SIGNATURE_INVALID', async () => {
      const req = buildReq(
        'sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb',
      );
      await expect(adapter.verifyInbound(req, channel)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        }),
      });
    });
    it('missing signature throws 401', async () => {
      await expect(
        adapter.verifyInbound(
          { headers: {}, rawBody: bodyBuf, body: {} },
          channel,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        }),
      });
    });
    it('tampered rawBody fails', async () => {
      const hmac = crypto
        .createHmac('sha256', secret)
        .update(bodyBuf)
        .digest('hex');
      const req: any = {
        headers: { 'x-vteam-signature': `sha256=${hmac}` },
        rawBody: Buffer.from('{"text":"tampered"}', 'utf-8'),
        body: JSON.parse(bodyStr),
      };
      await expect(adapter.verifyInbound(req, channel)).rejects.toThrow();
    });
  });

  describe('normalizeInbound with fieldMapping template', () => {
    it('renders fieldMapping templates and builds text [source] user: content', async () => {
      const ch: any = {
        ...channel,
        config: {
          fieldMapping: {
            content: '{{ body.content }}',
            source: 'github',
            user: '{{ user.name }}',
          },
        },
      };
      const body = {
        body: { content: 'hello world' },
        user: { name: 'Alice' },
      };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf-8');
      const req: any = {
        headers: { 'x-vteam-event-id': 'evt_123' },
        rawBody,
        body,
      };
      const cmds = await adapter.normalizeInbound(req, ch);
      expect(cmds).toHaveLength(1);
      expect((cmds[0] as any).text).toBe('[github] Alice: hello world');
      expect((cmds[0] as any).senderName).toBe('Alice');
      expect((cmds[0] as any).dedupKey).toBe('evt_123');
    });

    it('source/user optional', async () => {
      const ch: any = {
        ...channel,
        config: {
          fieldMapping: { content: '{{ body.content }}', source: '', user: '' },
        },
      };
      const body = { body: { content: 'only content' } };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf-8');
      const req: any = { headers: {}, rawBody, body };
      const cmds = await adapter.normalizeInbound(req, ch);
      expect((cmds[0] as any).text).toBe('only content');
      expect((cmds[0] as any).senderName).toBeUndefined();
    });

    it('fallback dedupKey is sha1(rawBody) when header missing', async () => {
      const bodyObj = { text: 'hi dedup fallback' };
      const rawBody = Buffer.from(JSON.stringify(bodyObj), 'utf-8');
      const expected = crypto.createHash('sha1').update(rawBody).digest('hex');
      const req: any = { headers: {}, rawBody, body: bodyObj };
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).dedupKey).toBe(expected);
    });

    it('without fieldMapping falls back to body.text', async () => {
      const body = { text: 'hello', sender: { id: 'u1', name: 'Bob' } };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf-8');
      const req: any = { headers: {}, rawBody, body };
      const cmds = await adapter.normalizeInbound(req, channel);
      expect((cmds[0] as any).text).toBe('hello');
      expect((cmds[0] as any).senderExternalId).toBe('u1');
      expect((cmds[0] as any).senderName).toBe('Bob');
    });
  });
});
