/**
 * serve-log 错误行判定单测：收集口径（isServeErrorLine）与致命口径（isServeFatalLine）。
 *
 * 重点覆盖「模型下架」双向：
 * - 顶层 `prompt_async failed … ProviderModelNotFoundError: Model not found` → 致命（快速 abort）；
 * - 子域 `share subscriber failed … ProviderModelNotFoundError: Model not found` → 非致命
 *   （子 agent 域失败，主循环存活，永不 abort——线上 08:18 一行双杀根因）。
 */

import {
  isServeErrorLine,
  isServeFatalLine,
  lineBelongsToSessionStrict,
} from './serve-log';

const TOP_LEVEL_MODEL_NOT_FOUND =
  'timestamp=2026-01-01T00:00:00.000Z level=ERROR run=abc123 message="prompt_async failed" sessionID=ses_mine cause="Cause([Die(ProviderModelNotFoundError: Model not found: opencode-go/space-bunny-free. Did you mean: space-bunny, cat-jam-free, longcat-2.5-preview-free?)])"';

const SUBSCRIBER_MODEL_NOT_FOUND =
  'timestamp=2026-09-21T08:18:15.258Z level=ERROR run=1879706f message="share subscriber failed" type=message.updated cause="Cause([Fail(ProviderModelNotFoundError: Model not found: opencode/gpt-5-nano.)])"';

describe('isServeErrorLine（收集口径，宽）', () => {
  it('顶层模型下架行入选（否则 worker 识别不到，只能空等首字超时）', () => {
    expect(isServeErrorLine(TOP_LEVEL_MODEL_NOT_FOUND)).toBe(true);
  });

  it('子域 share subscriber 模型下架行仍入选（供全局尸检，不决定 abort）', () => {
    expect(isServeErrorLine(SUBSCRIBER_MODEL_NOT_FOUND)).toBe(true);
  });

  it('INFO 行随机 id 含 429 不入选（结构化错误门防误报）', () => {
    expect(
      isServeErrorLine(
        'timestamp=t level=INFO run=x message=process messageID=msg_0a429eb46001rGylqWhDPAJKL6',
      ),
    ).toBe(false);
  });
});

describe('isServeFatalLine（致命口径，严）', () => {
  it('顶层 prompt_async failed + ProviderModelNotFoundError → 致命（快速 abort）', () => {
    expect(isServeFatalLine(TOP_LEVEL_MODEL_NOT_FOUND)).toBe(true);
  });

  it('子域 share subscriber failed + ProviderModelNotFoundError → 非致命（永不 abort 主循环）', () => {
    expect(isServeFatalLine(SUBSCRIBER_MODEL_NOT_FOUND)).toBe(false);
  });

  it('显式错误字段形态（无 level=ERROR）模型下架 → 致命（结构化门之二命中）', () => {
    const line =
      'timestamp=t message="prompt_async failed" sessionID=ses_mine error.name=ProviderModelNotFoundError error.message="Model not found: opencode-go/gone"';
    expect(isServeFatalLine(line)).toBe(true);
  });

  it('无结构化错误门的裸 Model not found（缺 level/error 字段）→ 非致命（防误杀）', () => {
    expect(isServeFatalLine('message="noise" text="Model not found in docs"')).toBe(false);
  });

  it('既有致命原因（Rate limit / AI_APICallError）仍命中（回归不破）', () => {
    expect(
      isServeFatalLine(
        'level=ERROR message="stream error" error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
      ),
    ).toBe(true);
  });

  it('裸 stream error 包装行（无具体原因）→ 非致命（回归不破）', () => {
    expect(
      isServeFatalLine('timestamp=t level=ERROR run=abc message="stream error" session.id=ses_1'),
    ).toBe(false);
  });
});

describe('lineBelongsToSessionStrict（模型下架行的会话归属）', () => {
  it('顶层 prompt_async failed 行的 sessionID=ses_mine 正确归属于本会话', () => {
    expect(lineBelongsToSessionStrict(TOP_LEVEL_MODEL_NOT_FOUND, 'ses_mine')).toBe(true);
    expect(lineBelongsToSessionStrict(TOP_LEVEL_MODEL_NOT_FOUND, 'ses_other')).toBe(false);
  });
});
