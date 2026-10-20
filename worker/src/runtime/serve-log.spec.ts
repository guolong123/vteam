/**
 * serve-log 错误行判定单测：收集口径（isServeErrorLine）与致命口径（isServeFatalLine），
 * 以及 v2 配置归一化诊断的独立识别（parseConfigNormalizationDiagnostic）。
 *
 * 重点覆盖「模型下架」双向：
 * - 顶层 `prompt_async failed … ProviderModelNotFoundError: Model not found` → 致命（快速 abort）；
 * - 子域 `share subscriber failed … ProviderModelNotFoundError: Model not found` → 非致命
 *   （子 agent 域失败，主循环存活，永不 abort——线上 08:18 一行双杀根因）。
 *
 * 另覆盖 v2 静默降级信号（配置归一化诊断）：
 * - 真实形态的 WARN 行 → 认出并点名被丢弃的键路径；
 * - 普通 INFO 行 → 不误报；
 * - 归一化诊断是**配置错误**，不进致命口径（不误杀在跑的健康会话）。
 */

import {
  formatConfigNormalizationError,
  isConfigNormalizationLine,
  isServeErrorLine,
  isServeFatalLine,
  lineBelongsToSessionStrict,
  parseConfigNormalizationDiagnostic,
} from './serve-log';

const TOP_LEVEL_MODEL_NOT_FOUND =
  'timestamp=2026-01-01T00:00:00.000Z level=ERROR run=abc123 message="prompt_async failed" sessionID=ses_mine cause="Cause([Die(ProviderModelNotFoundError: Model not found: opencode-go/space-bunny-free. Did you mean: space-bunny, cat-jam-free, longcat-2.5-preview-free?)])"';

const SUBSCRIBER_MODEL_NOT_FOUND =
  'timestamp=2026-09-21T08:18:15.258Z level=ERROR run=1879706f message="share subscriber failed" type=message.updated cause="Cause([Fail(ProviderModelNotFoundError: Model not found: opencode/gpt-5-nano.)])"';

/** v2 归一化诊断真实形态（opencode v2.0.28 实测逐字捕获）。 */
const REAL_NORMALIZATION_WARN =
  'timestamp=2026-10-20T01:37:51.247Z level=WARN run=ce481823 message="configuration normalization diagnostic" source=/Users/mac/.config/opencode/opencode.json path=$.provider.keta-qwen.models.ornith-1.5:35b.reasoning kind=unsupported action="omitted unsupported legacy setting" http.span=32 role=server';

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

  it('T7：v2 配置归一化 WARN 入选收集口径（配置错误不得被静默吞掉）', () => {
    expect(isServeErrorLine(REAL_NORMALIZATION_WARN)).toBe(true);
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

describe('T7 v2 配置归一化诊断（静默降级的可见化）', () => {
  it('真实形态的 WARN 行 → 认出，并点名被丢弃的键路径', () => {
    const diag = parseConfigNormalizationDiagnostic(REAL_NORMALIZATION_WARN);
    expect(diag).not.toBeNull();
    expect(diag?.keyPath).toBe(
      '$.provider.keta-qwen.models.ornith-1.5:35b.reasoning',
    );
    expect(diag?.kind).toBe('unsupported');
    expect(diag?.action).toBe('omitted unsupported legacy setting');
    expect(diag?.source).toBe('/Users/mac/.config/opencode/opencode.json');
    expect(isConfigNormalizationLine(REAL_NORMALIZATION_WARN)).toBe(true);
  });

  it('普通 INFO 行 → 不误报', () => {
    const infoLine =
      'timestamp=2026-10-20T01:37:42.601Z level=INFO run=ce481823 message="cli starting" version=2.0.28 channel=latest local=false role=cli';
    expect(isConfigNormalizationLine(infoLine)).toBe(false);
    expect(parseConfigNormalizationDiagnostic(infoLine)).toBeNull();
  });

  it('普通 INFO 行（消息里带 "normalization" 字样）→ 仍不误报', () => {
    const infoLine =
      'timestamp=t level=INFO run=x message="configuration normalization started" path=$.a.b role=cli';
    expect(isConfigNormalizationLine(infoLine)).toBe(false);
  });

  it('换一条路径的 WARN → 照样认出，路径照样抽得出来', () => {
    const line =
      'timestamp=2026-10-20T00:24:21.299Z level=WARN run=b8c30c16 message="configuration normalization diagnostic" source=/Users/mac/.config/opencode/opencode.json path=$.provider.other.models.gpt-4o.tool_call kind=unsupported action="omitted unsupported legacy setting" http.span=32 role=server';
    const diag = parseConfigNormalizationDiagnostic(line);
    expect(diag?.keyPath).toBe('$.provider.other.models.gpt-4o.tool_call');
    expect(isConfigNormalizationLine(line)).toBe(true);
  });

  it('没有 path= 字段 → 仍能认出，路径为 null（不抛错、不崩）', () => {
    const line =
      'timestamp=t level=WARN run=x message="configuration normalization diagnostic" source=/tmp/opencode.json kind=unsupported action="omitted unsupported legacy setting" role=server';
    const diag = parseConfigNormalizationDiagnostic(line);
    expect(diag).not.toBeNull();
    expect(diag?.keyPath).toBeNull();
    expect(diag?.kind).toBe('unsupported');
  });

  it('空串 / 非字符串 → 不崩，返回 null', () => {
    expect(parseConfigNormalizationDiagnostic('')).toBeNull();
    expect(parseConfigNormalizationDiagnostic(undefined as unknown as string)).toBeNull();
  });

  it('错误文案点名被丢的键路径 + 给出修法（可操作）', () => {
    const diag = parseConfigNormalizationDiagnostic(REAL_NORMALIZATION_WARN);
    const message = formatConfigNormalizationError(diag!);
    expect(message).toContain(
      '$.provider.keta-qwen.models.ornith-1.5:35b.reasoning',
    );
    expect(message).toContain('capabilities');
  });

  it('配置错误 ≠ 模型 API 错误：归一化 WARN 不进致命口径（不误杀在跑的健康会话）', () => {
    expect(isServeFatalLine(REAL_NORMALIZATION_WARN)).toBe(false);
  });

  it('同一行若另带明确模型错误 → 以模型错误为准（它才是本轮失败的原因）', () => {
    const line = `${REAL_NORMALIZATION_WARN} error.error="AI_APICallError: Rate limit exceeded."`;
    expect(isServeFatalLine(line)).toBe(true);
  });
});
