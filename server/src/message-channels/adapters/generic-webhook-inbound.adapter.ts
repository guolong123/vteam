import * as crypto from 'crypto';
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InboundCommand,
  MessageAdapter,
  MessageChannelResolved,
} from '../message-adapter';
import {
  MESSAGE_CHANNEL_TYPES,
  INTEGRATIONS_ERRORS,
} from '../message-channel.constants';
import { renderFieldTemplate } from '../field-template.util';

/**
 * GenericWebhook 入站适配器（inbound-only）。
 * - type = 'generic_webhook'
 * - verifyInbound: 校验 x-vteam-signature = sha256= HMAC(rawBody, secret) + timingSafeEqual
 * - normalizeInbound: 支持 per-event 映射 config.fieldMappings: { [event]: {content,source,user}, _default: {...} }
 *   按 X-GitHub-Event / X-Gitee-Event / X-Git-Oschina-Event 取 event 名，查 fieldMappings[event] 回退 _default，
 *   再回退 legacy config.fieldMapping（向后兼容），最后回退 body.text。
 * - 渲染依赖 field-template.util 的 {{ path }}（支持 a.b.c 和 a[0].b）。
 */
@Injectable()
export class GenericWebhookInboundAdapter extends MessageAdapter {
  readonly type = MESSAGE_CHANNEL_TYPES.generic_webhook;

  supportsInbound = true;

  private getRawBody(req: any): Buffer {
    if (req.rawBody && Buffer.isBuffer(req.rawBody))
      return req.rawBody as Buffer;
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
    if (typeof req.rawBody === 'string')
      return Buffer.from(req.rawBody, 'utf-8');
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) return req.body as Buffer;
      if (typeof req.body === 'string') return Buffer.from(req.body, 'utf-8');
      try {
        return Buffer.from(JSON.stringify(req.body), 'utf-8');
      } catch {
        return Buffer.alloc(0);
      }
    }
    return Buffer.alloc(0);
  }

  private getHeader(req: any, name: string): string | undefined {
    const v = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) return v[0]?.toString();
    return v.toString();
  }

  async verifyInbound(
    req: any,
    channel: MessageChannelResolved,
  ): Promise<void> {
    const secrets = (channel.secrets ?? {}) as Record<string, any>;
    const secret: string | undefined =
      secrets.secret ?? secrets.token ?? secrets.webhookSecret;
    if (!secret) {
      throw new UnauthorizedException({
        code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        message: 'webhook secret not configured',
      });
    }
    const signature = this.getHeader(req, 'x-vteam-signature');
    if (!signature) {
      throw new UnauthorizedException({
        code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        message: 'missing x-vteam-signature',
      });
    }
    const rawBody = this.getRawBody(req);
    const hmac = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    const expected = `sha256=${hmac}`;
    const a = Buffer.from(signature, 'utf-8');
    const b = Buffer.from(expected, 'utf-8');
    let equal = false;
    if (a.length === b.length) {
      equal = crypto.timingSafeEqual(a, b);
    } else {
      crypto.timingSafeEqual(b, b);
      equal = false;
    }
    if (!equal) {
      throw new UnauthorizedException({
        code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        message: 'signature mismatch',
      });
    }
  }

  private resolveFieldMapping(
    event: string,
    config: Record<string, any>,
  ): Record<string, string> | undefined {
    const fieldMappings = (config as any)?.fieldMappings as
      | Record<string, any>
      | undefined;
    if (
      fieldMappings &&
      typeof fieldMappings === 'object' &&
      !Array.isArray(fieldMappings)
    ) {
      // direct event lookup, case-sensitive + lowercased variant
      const perEvent =
        fieldMappings[event] ??
        fieldMappings[event?.toLowerCase?.()] ??
        undefined;
      if (perEvent && typeof perEvent === 'object' && !Array.isArray(perEvent)) {
        return perEvent as Record<string, string>;
      }
      const def = fieldMappings['_default'];
      if (def && typeof def === 'object' && !Array.isArray(def)) {
        return def as Record<string, string>;
      }
      // if fieldMappings itself looks like a mapping (has content/source/user), treat as _default
      if (
        typeof (fieldMappings as any).content === 'string' ||
        typeof (fieldMappings as any).source === 'string' ||
        typeof (fieldMappings as any).user === 'string'
      ) {
        return fieldMappings as unknown as Record<string, string>;
      }
      // fieldMappings present but no match → if legacy exists, return legacy via fallback below
      if (perEvent === undefined && def === undefined) {
        const legacy = (config as any)?.fieldMapping as
          | Record<string, string>
          | undefined;
        if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
          return legacy;
        }
        return undefined;
      }
    }
    const legacy = (config as any)?.fieldMapping as
      | Record<string, string>
      | undefined;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      return legacy;
    }
    return undefined;
  }

  private resolveEventName(req: any, parsed: any): string {
    return (
      this.getHeader(req, 'x-github-event') ??
      this.getHeader(req, 'X-Github-Event') ??
      this.getHeader(req, 'x-gitee-event') ??
      this.getHeader(req, 'X-Gitee-Event') ??
      this.getHeader(req, 'x-git-oschina-event') ??
      this.getHeader(req, 'X-Git-Oschina-Event') ??
      (typeof parsed?.hook_name === 'string' ? parsed.hook_name : undefined) ??
      this.getHeader(req, 'x-vteam-event') ??
      ''
    );
  }

  async normalizeInbound(
    req: any,
    channel: MessageChannelResolved,
  ): Promise<InboundCommand[]> {
    const rawBody = this.getRawBody(req);
    let parsed: any;
    if (
      req.body !== undefined &&
      req.body !== null &&
      typeof req.body === 'object' &&
      !Buffer.isBuffer(req.body)
    ) {
      parsed = req.body;
    } else if (typeof req.body === 'string') {
      try {
        parsed = JSON.parse(req.body);
      } catch {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'invalid JSON body',
        });
      }
    } else {
      const str = rawBody.toString('utf-8');
      if (!str) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'empty body',
        });
      }
      try {
        parsed = JSON.parse(str);
      } catch {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'invalid JSON body',
        });
      }
    }

    const dedupHeader = this.getHeader(req, 'x-vteam-event-id');
    const dedupKey = dedupHeader
      ? dedupHeader.toString()
      : crypto.createHash('sha1').update(rawBody).digest('hex');

    const eventName = this.resolveEventName(req, parsed);
    const fieldMapping = this.resolveFieldMapping(
      eventName,
      (channel.config ?? {}) as Record<string, any>,
    );

    if (fieldMapping && typeof fieldMapping === 'object') {
      const contentTpl = (fieldMapping as any).content;
      const sourceTpl = (fieldMapping as any).source;
      const userTpl = (fieldMapping as any).user;

      const content =
        typeof contentTpl === 'string'
          ? renderFieldTemplate(contentTpl, parsed)
          : '';
      const source =
        typeof sourceTpl === 'string'
          ? renderFieldTemplate(sourceTpl, parsed)
          : '';
      const user =
        typeof userTpl === 'string' ? renderFieldTemplate(userTpl, parsed) : '';

      // When fieldMapping present, content is derived from templates; if empty and no templates, fallback to body.text
      let finalContent = content;
      if (!finalContent) {
        if (typeof parsed?.text === 'string') finalContent = parsed.text;
        else if (typeof parsed?.content === 'string')
          finalContent = parsed.content;
        else finalContent = '';
      }
      if (!finalContent) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'content is required and must be a string',
        });
      }
      if (finalContent.length > 8000) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'text exceeds 8000 characters',
        });
      }

      const prefixSource = source ? `[${source}] ` : '';
      const prefixUser = user ? `${user}: ` : '';
      const text = `${prefixSource}${prefixUser}${finalContent}`;

      const cmd: InboundCommand = {
        kind: 'post_message',
        text,
        senderName: user || undefined,
        dedupKey,
      };
      // optional senderExternalId from user mapping fallback - not derived, keep undefined
      return [cmd];
    }

    // fallback to body.text
    const text = parsed?.text;
    if (typeof text !== 'string') {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'text is required and must be a string',
      });
    }
    if (text.length > 8000) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'text exceeds 8000 characters',
      });
    }
    const sender = parsed?.sender;
    const cmd: InboundCommand = {
      kind: 'post_message',
      text,
      senderExternalId: sender?.id?.toString() ?? undefined,
      senderName: sender?.name?.toString() ?? undefined,
      dedupKey,
    };
    return [cmd];
  }
}
