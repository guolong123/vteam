import * as crypto from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
  NotificationAdapter,
  NotificationChannelResolved,
  OutboundMessage,
} from '../notification-adapter';
import { NOTIFICATION_TYPES } from '../notification.constants';

@Injectable()
export class WebhookNotificationAdapter extends NotificationAdapter {
  readonly type = NOTIFICATION_TYPES.webhook;

  supportsOutbound = true;

  async sendOutbound(
    channel: NotificationChannelResolved,
    msg: OutboundMessage,
  ): Promise<{ externalId: string | null; meta?: Record<string, any> }> {
    const targetUrl: string | undefined = (
      channel.config as Record<string, any>
    )?.targetUrl;
    if (!targetUrl) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'config.targetUrl is required for outbound',
      });
    }
    const secrets = (channel.secrets ?? {}) as Record<string, any>;
    const secret: string | undefined =
      secrets.secret ?? secrets.token ?? secrets.webhookSecret;

    const bodyObj: Record<string, unknown> = {
      event: msg.kind,
      text: msg.text,
      title: msg.title ?? null,
      ts: Date.now(),
    };

    const bodyStr = JSON.stringify(bodyObj);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (secret) {
      const hmac = crypto
        .createHmac('sha256', secret)
        .update(Buffer.from(bodyStr, 'utf-8'))
        .digest('hex');
      headers['x-vteam-signature'] = `sha256=${hmac}`;
    }

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: bodyStr,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(
          `outbound POST failed ${res.status}: ${errText.slice(0, 512)}`,
        );
      }
      let externalId: string | null = null;
      try {
        const json: any = await res.clone().json();
        externalId =
          json?.id?.toString() ?? json?.externalId?.toString() ?? null;
      } catch {}
      if (!externalId) {
        externalId = crypto
          .createHash('sha1')
          .update(bodyStr)
          .digest('hex')
          .slice(0, 16);
      }
      return { externalId, meta: { status: res.status } };
    } catch (e) {
      throw e;
    }
  }
}
