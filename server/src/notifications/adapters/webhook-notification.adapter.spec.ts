import * as crypto from 'crypto';
import { WebhookNotificationAdapter } from './webhook-notification.adapter';

describe('WebhookNotificationAdapter', () => {
  let adapter: WebhookNotificationAdapter;
  const secret = 'notif-secret';
  const channel: any = {
    id: 'nc_0000000001',
    type: 'webhook',
    config: { targetUrl: 'https://example.com/hook' },
    secrets: { secret },
    enabled: true,
  };

  beforeEach(() => {
    adapter = new WebhookNotificationAdapter();
  });

  it('type webhook and supportsOutbound only', () => {
    expect(adapter.type).toBe('webhook');
    expect(adapter.supportsOutbound).toBe(true);
    expect((adapter as any).verifyInbound).toBeUndefined();
  });

  it('throws when targetUrl missing', async () => {
    const noUrlChannel = { ...channel, config: {} };
    await expect(
      adapter.sendOutbound(noUrlChannel, { kind: 'text', text: 'hi' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('POSTs with x-vteam-signature header and JSON body, returns externalId', async () => {
    const captured: { url?: string; headers?: any; body?: string } = {};
    const mockJson = { id: 'ext_999' };
    const originalFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockImplementation(async (url: string, init: any) => {
        captured.url = url;
        captured.headers = init.headers;
        captured.body = init.body;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(mockJson),
          json: async () => mockJson,
          clone() {
            return { json: async () => mockJson } as any;
          },
        } as any;
      });
    try {
      const res = await adapter.sendOutbound(channel, {
        kind: 'text',
        text: 'out hello',
        title: 'T',
      });
      expect(captured.url).toBe('https://example.com/hook');
      expect(captured.headers['x-vteam-signature']).toMatch(
        /^sha256=[a-f0-9]{64}$/,
      );
      const expectedHmac = crypto
        .createHmac('sha256', secret)
        .update(Buffer.from(captured.body!, 'utf-8'))
        .digest('hex');
      expect(captured.headers['x-vteam-signature']).toBe(
        `sha256=${expectedHmac}`,
      );
      const parsedBody = JSON.parse(captured.body!);
      expect(parsedBody).toEqual(
        expect.objectContaining({ text: 'out hello', title: 'T' }),
      );
      expect(res.externalId).toBe('ext_999');
    } finally {
      global.fetch = originalFetch;
      jest.restoreAllMocks();
    }
  });

  it('without secret does not add signature header', async () => {
    const noSecretChannel = { ...channel, secrets: {} };
    let capturedHeaders: any;
    const originalFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockImplementation(async (_url: string, init: any) => {
        capturedHeaders = init.headers;
        return {
          ok: true,
          status: 200,
          text: async () => '{}',
          json: async () => ({}),
          clone() {
            return { json: async () => ({}) } as any;
          },
        } as any;
      });
    try {
      await adapter.sendOutbound(noSecretChannel, {
        kind: 'text',
        text: 'no sig',
      });
      expect(capturedHeaders['x-vteam-signature']).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('falls back to sha1-based externalId when response has no id', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({}),
      clone() {
        return { json: async () => ({}) } as any;
      },
    } as any);
    try {
      const res = await adapter.sendOutbound(channel, {
        kind: 'text',
        text: 'fallback id',
      });
      expect(res.externalId).toBeDefined();
      expect(typeof res.externalId).toBe('string');
      expect((res.externalId as string).length).toBeGreaterThan(0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
