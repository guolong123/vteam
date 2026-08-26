import { BadRequestException, Injectable } from '@nestjs/common';
import {
  NotificationAdapter,
  NotificationChannelResolved,
  OutboundMessage,
} from '../notification-adapter';
import { NOTIFICATION_TYPES } from '../notification.constants';

@Injectable()
export class WecomGroupRobotAdapter extends NotificationAdapter {
  readonly type = NOTIFICATION_TYPES.wecom_group_robot;

  supportsOutbound = true;

  async sendOutbound(
    channel: NotificationChannelResolved,
    msg: OutboundMessage,
  ): Promise<{ externalId: string | null; meta?: Record<string, any> }> {
    const targetUrl: string | undefined =
      (channel.config as Record<string, any>)?.targetUrl ??
      (channel.config as Record<string, any>)?.webhookUrl ??
      (channel.config as Record<string, any>)?.url;
    if (!targetUrl) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'config.targetUrl is required for outbound',
      });
    }

    const payload: Record<string, unknown> =
      msg.kind === 'markdown'
        ? { msgtype: 'markdown', markdown: { content: msg.text } }
        : msg.kind === 'text'
          ? { msgtype: 'text', text: { content: msg.text } }
          : { msgtype: 'markdown', markdown: { content: msg.text } };

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(
          `wecom group robot POST failed ${res.status}: ${errText.slice(0, 512)}`,
        );
      }
      // WeCom robot returns JSON { errcode:0, errmsg:"ok" }
      let json: any = null;
      try {
        json = await res.clone().json();
      } catch {}
      if (json && typeof json.errcode === 'number' && json.errcode !== 0) {
        throw new Error(json.errmsg ?? `wecom errcode=${json.errcode}`);
      }
      // no external id from robot, return null or cloned json id
      const externalId = json?.id?.toString() ?? null;
      return { externalId, meta: { status: res.status } };
    } catch (e) {
      throw e;
    }
  }
}
