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
 * Gitee per-event built-in templates.
 * Keys are normalized hook_name values (lowercase) as sent in X-Gitee-Event / X-Git-Oschina-Event
 * and also in body hook_name. Backend normalizes via toLowerCase and generic fallback.
 */
export const GITEE_BUILTIN_TEMPLATES: Record<
  string,
  { content: string; source: string; user: string }
> = {
  push_hooks: {
    content: '{{ head_commit.message }}',
    source: '{{ project.path_with_namespace }}',
    user: '{{ pusher.name }}',
  },
  tag_push_hooks: {
    content: '{{ ref }}',
    source: '{{ project.path_with_namespace }}',
    user: '{{ pusher.name }}',
  },
  issue_hooks: {
    content: '{{ issue.title }}',
    source: '{{ project.path_with_namespace }}',
    user: '{{ sender.login }}',
  },
  merge_request_hooks: {
    content: '{{ pull_request.title }}',
    source: '{{ project.path_with_namespace }}',
    user: '{{ sender.login }}',
  },
  note_hooks: {
    content: '{{ comment.body }}',
    source: '{{ project.path_with_namespace }}',
    user: '{{ sender.login }}',
  },
};

export const BUILTIN_TEMPLATES = GITEE_BUILTIN_TEMPLATES;

@Injectable()
export class GiteeWebhookAdapter extends MessageAdapter {
  readonly type = MESSAGE_CHANNEL_TYPES.gitee_webhook;

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
    const token =
      this.getHeader(req, 'x-gitee-token') ??
      this.getHeader(req, 'X-Gitee-Token');
    if (!token) {
      throw new UnauthorizedException({
        code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        message: 'missing X-Gitee-Token',
      });
    }
    const a = Buffer.from(token, 'utf-8');
    const b = Buffer.from(secret, 'utf-8');
    let equal = false;
    if (a.length === b.length) {
      equal = crypto.timingSafeEqual(a, b);
    } else {
      // constant-time dummy
      const dummy = Buffer.from(secret, 'utf-8');
      crypto.timingSafeEqual(dummy, dummy);
      equal = false;
    }
    if (!equal) {
      throw new UnauthorizedException({
        code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        message: 'token mismatch',
      });
    }
  }

  private normalizeEventKey(event: string): string {
    const e = (event || '').toLowerCase().trim();
    if (!e) return '';
    // direct key match
    if ((GITEE_BUILTIN_TEMPLATES as Record<string, any>)[e]) return e;
    // hook_name mapping variations: Gitee sends "Push Hook" / "push_hooks" etc
    if (e.includes('tag_push')) return 'tag_push_hooks';
    if (e === 'push hook' || e === 'push' || e.includes('push_hooks')) return 'push_hooks';
    if (e.includes('issue')) return 'issue_hooks';
    if (e.includes('merge_request') || e.includes('pull_request') || e.includes('merge request'))
      return 'merge_request_hooks';
    if (e.includes('note') || e.includes('comment')) return 'note_hooks';
    return e;
  }

  private defaultFieldMapping(event: string): Record<string, string> {
    const key = this.normalizeEventKey(event);
    const tpl = (GITEE_BUILTIN_TEMPLATES as Record<string, any>)[key];
    if (tpl) return tpl;
    return {
      content: '{{ action }}',
      source: '{{ project.path_with_namespace }}',
      user: '{{ sender.login }}',
    };
  }

  private resolveFieldMapping(
    event: string,
    config: Record<string, any>,
  ): Record<string, string> {
    const fieldMappings = (config as any)?.fieldMappings as
      | Record<string, any>
      | undefined;
    if (
      fieldMappings &&
      typeof fieldMappings === 'object' &&
      !Array.isArray(fieldMappings)
    ) {
      const key = this.normalizeEventKey(event);
      // try exact event, normalized, and raw lower
      const candidates = [event, key, (event || '').toLowerCase()];
      for (const c of candidates) {
        const perEvent = fieldMappings[c];
        if (perEvent && typeof perEvent === 'object' && !Array.isArray(perEvent)) {
          return perEvent as Record<string, string>;
        }
      }
      const def = fieldMappings['_default'];
      if (def && typeof def === 'object' && !Array.isArray(def)) {
        return def as Record<string, string>;
      }
      if (
        typeof (fieldMappings as any).content === 'string' ||
        typeof (fieldMappings as any).source === 'string' ||
        typeof (fieldMappings as any).user === 'string'
      ) {
        return fieldMappings as unknown as Record<string, string>;
      }
    }
    const legacy = (config as any)?.fieldMapping as
      | Record<string, string>
      | undefined;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      return legacy;
    }
    return this.defaultFieldMapping(event);
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

    // Gitee sends X-Gitee-Event or X-Git-Oschina-Event header, fallback to hook_name in body
    const event =
      this.getHeader(req, 'x-gitee-event') ??
      this.getHeader(req, 'X-Gitee-Event') ??
      this.getHeader(req, 'x-git-oschina-event') ??
      this.getHeader(req, 'X-Git-Oschina-Event') ??
      (parsed?.hook_name as string) ??
      '';

    const dedupHeader =
      this.getHeader(req, 'x-gitee-timestamp') ??
      this.getHeader(req, 'x-gitee-request-id');
    const dedupKey = dedupHeader
      ? dedupHeader.toString()
      : crypto.createHash('sha1').update(rawBody).digest('hex');

    const mapping = this.resolveFieldMapping(
      event,
      (channel.config ?? {}) as Record<string, any>,
    );

    const contentTpl = (mapping as any).content;
    const sourceTpl = (mapping as any).source;
    const userTpl = (mapping as any).user;

    let content =
      typeof contentTpl === 'string'
        ? renderFieldTemplate(contentTpl, parsed)
        : '';
    let source =
      typeof sourceTpl === 'string'
        ? renderFieldTemplate(sourceTpl, parsed)
        : '';
    let user =
      typeof userTpl === 'string' ? renderFieldTemplate(userTpl, parsed) : '';

    if (!content) {
      if (Array.isArray(parsed?.commits) && parsed.commits[0]?.message)
        content = String(parsed.commits[0].message);
      else if (typeof parsed?.head_commit?.message === 'string')
        content = parsed.head_commit.message;
      else if (typeof parsed?.issue?.title === 'string')
        content = parsed.issue.title;
      else if (typeof parsed?.pull_request?.title === 'string')
        content = parsed.pull_request.title;
      else if (typeof parsed?.comment?.body === 'string')
        content = parsed.comment.body;
      else if (typeof parsed?.ref === 'string') content = parsed.ref;
      else if (typeof parsed?.action === 'string') content = parsed.action;
      else if (typeof parsed?.text === 'string') content = parsed.text;
      else {
        try {
          content = JSON.stringify(parsed).slice(0, 2000);
        } catch {
          content = event || 'gitee event';
        }
      }
    }
    if (!source) {
      if (typeof parsed?.project?.path_with_namespace === 'string')
        source = parsed.project.path_with_namespace;
      else if (typeof parsed?.repository?.full_name === 'string')
        source = parsed.repository.full_name;
      else if (typeof parsed?.project?.name === 'string')
        source = parsed.project.name;
      else source = 'gitee';
    }
    if (!user) {
      if (typeof parsed?.pusher?.name === 'string') user = parsed.pusher.name;
      else if (typeof parsed?.sender?.login === 'string')
        user = parsed.sender.login;
      else if (typeof parsed?.user?.name === 'string') user = parsed.user.name;
    }

    if (content.length > 8000) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'text exceeds 8000 characters',
      });
    }

    const prefixSource = source ? `[${source}] ` : '';
    const prefixUser = user ? `${user}: ` : '';
    const text = `${prefixSource}${prefixUser}${content}`;

    const cmd: InboundCommand = {
      kind: 'post_message',
      text,
      senderName: user || undefined,
      dedupKey,
    };
    return [cmd];
  }
}
