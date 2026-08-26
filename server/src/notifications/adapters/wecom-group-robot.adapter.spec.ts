import { WecomGroupRobotAdapter } from './wecom-group-robot.adapter';

describe('WecomGroupRobotAdapter', () => {
  let adapter: WecomGroupRobotAdapter;
  const channel: any = {
    id: 'nc_0000000002',
    type: 'wecom_group_robot',
    config: {
      targetUrl:
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key',
    },
    secrets: {},
    enabled: true,
  };

  beforeEach(() => {
    adapter = new WecomGroupRobotAdapter();
  });

  it('type wecom_group_robot and supportsOutbound only', () => {
    expect(adapter.type).toBe('wecom_group_robot');
    expect(adapter.supportsOutbound).toBe(true);
    expect((adapter as any).verifyInbound).toBeUndefined();
  });

  it('throws when targetUrl missing', async () => {
    const noUrlChannel = { ...channel, config: {} };
    await expect(
      adapter.sendOutbound(noUrlChannel, { kind: 'text', text: 'hi' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('POSTs markdown payload to wecom webhook URL', async () => {
    const captured: { url?: string; headers?: any; body?: string } = {};
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
          text: async () => JSON.stringify({ errcode: 0, errmsg: 'ok' }),
          json: async () => ({ errcode: 0, errmsg: 'ok' }),
          clone() {
            return { json: async () => ({ errcode: 0, errmsg: 'ok' }) } as any;
          },
        } as any;
      });
    try {
      const res = await adapter.sendOutbound(channel, {
        kind: 'markdown',
        text: 'hello **world**',
      });
      expect(captured.url).toBe(
        'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key',
      );
      const parsed = JSON.parse(captured.body!);
      expect(parsed).toEqual({
        msgtype: 'markdown',
        markdown: { content: 'hello **world**' },
      });
      expect(res.meta).toEqual(expect.objectContaining({ status: 200 }));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('text kind uses msgtype text', async () => {
    let capturedBody: string | undefined;
    const originalFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockImplementation(async (_url: string, init: any) => {
        capturedBody = init.body;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ errcode: 0, errmsg: 'ok' }),
          json: async () => ({ errcode: 0, errmsg: 'ok' }),
          clone() {
            return { json: async () => ({ errcode: 0, errmsg: 'ok' }) } as any;
          },
        } as any;
      });
    try {
      await adapter.sendOutbound(channel, { kind: 'text', text: 'plain text' });
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.msgtype).toBe('text');
      expect(parsed.text.content).toBe('plain text');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws on non-ok response', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    } as any);
    try {
      await expect(
        adapter.sendOutbound(channel, { kind: 'text', text: 'hi' }),
      ).rejects.toThrow();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws on wecom errcode non-zero', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ errcode: 400, errmsg: 'bad request' }),
        json: async () => ({ errcode: 400, errmsg: 'bad request' }),
        clone() {
          return {
            json: async () => ({ errcode: 400, errmsg: 'bad request' }),
          } as any;
        },
      } as any;
    });
    try {
      await expect(
        adapter.sendOutbound(channel, { kind: 'text', text: 'hi' }),
      ).rejects.toThrow('bad request');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
