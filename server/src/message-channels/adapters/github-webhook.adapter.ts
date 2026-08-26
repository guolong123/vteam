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
 * GitHub per-event built-in templates.
 * Each event maps to {content, source, user} field-template strings.
 * Frontend dropdown reads this list; backend selects by X-GitHub-Event with fallback.
 * Paths correspond to docs.github.com/webhooks payload shapes.
 */
export const GITHUB_BUILTIN_TEMPLATES: Record<
  string,
  { content: string; source: string; user: string }
> = {
  push: {
    content: '{{ head_commit.message }}',
    source: '{{ repository.full_name }}',
    user: '{{ pusher.name }}',
  },
  pull_request: {
    content: '{{ pull_request.title }} - {{ pull_request.body }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  issues: {
    content: '{{ issue.title }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  issue_comment: {
    content: '{{ comment.body }}',
    source: '{{ repository.full_name }}',
    user: '{{ comment.user.login }}',
  },
  pull_request_review: {
    content: '{{ review.body }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  pull_request_review_comment: {
    content: '{{ comment.body }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  create: {
    content: '{{ ref }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  delete: {
    content: '{{ ref }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  fork: {
    content: '{{ forkee.full_name }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  release: {
    content: '{{ release.tag_name }} {{ release.name }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  star: {
    content: '{{ action }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  ping: {
    content: '{{ zen }}',
    source: 'github',
    user: '{{ sender.login }}',
  },
  check_run: {
    content: '{{ check_run.name }} {{ check_run.conclusion }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
  deployment: {
    content: '{{ deployment.environment }}',
    source: '{{ repository.full_name }}',
    user: '{{ sender.login }}',
  },
};

// alias for spec/test import compatibility
export const BUILTIN_TEMPLATES = GITHUB_BUILTIN_TEMPLATES;

@Injectable()
export class GithubWebhookAdapter extends MessageAdapter {
  readonly type = MESSAGE_CHANNEL_TYPES.github_webhook;

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
    const signature =
      this.getHeader(req, 'x-hub-signature-256') ??
      this.getHeader(req, 'X-Hub-Signature-256');
    if (!signature) {
      throw new UnauthorizedException({
        code: INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
        message: 'missing X-Hub-Signature-256',
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

  private defaultFieldMapping(event: string): Record<string, string> {
    const tpl = (GITHUB_BUILTIN_TEMPLATES as Record<string, any>)[event];
    if (tpl) return tpl;
    return {
      content: '{{ action }}',
      source: '{{ repository.full_name }}',
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
      const perEvent = fieldMappings[event];
      if (perEvent && typeof perEvent === 'object' && !Array.isArray(perEvent)) {
        return perEvent as Record<string, string>;
      }
      const def = fieldMappings['_default'];
      if (def && typeof def === 'object' && !Array.isArray(def)) {
        return def as Record<string, string>;
      }
      // fieldMappings present but no matching event/_default -> fall through to built-in
      if (perEvent === undefined && def === undefined) {
        // if map contains content/source/user directly (mis-shaped), treat as mapping
        if (
          typeof (fieldMappings as any).content === 'string' ||
          typeof (fieldMappings as any).source === 'string' ||
          typeof (fieldMappings as any).user === 'string'
        ) {
          return fieldMappings as unknown as Record<string, string>;
        }
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

    const event =
      this.getHeader(req, 'x-github-event') ??
      this.getHeader(req, 'X-Github-Event') ??
      '';

    const dedupHeader =
      this.getHeader(req, 'x-github-delivery') ??
      this.getHeader(req, 'X-Github-Delivery');
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

    // Fallback handling when default templates produce empty: try sensible fallbacks
    if (!content) {
      if (typeof parsed?.head_commit?.message === 'string')
        content = parsed.head_commit.message;
      else if (typeof parsed?.comment?.body === 'string')
        content = parsed.comment.body;
      else if (typeof parsed?.issue?.title === 'string')
        content = parsed.issue.title;
      else if (typeof parsed?.pull_request?.title === 'string')
        content = parsed.pull_request.title;
      else if (typeof parsed?.zen === 'string') content = parsed.zen;
      else if (typeof parsed?.action === 'string') content = parsed.action;
      else if (typeof parsed?.text === 'string') content = parsed.text;
      else {
        try {
          content = JSON.stringify(parsed).slice(0, 2000);
        } catch {
          content = event || 'github event';
        }
      }
    }
    if (!source) {
      if (typeof parsed?.repository?.full_name === 'string')
        source = parsed.repository.full_name;
      else source = 'github';
    }
    if (!user) {
      if (typeof parsed?.sender?.login === 'string') user = parsed.sender.login;
      else if (typeof parsed?.pusher?.name === 'string')
        user = parsed.pusher.name;
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
