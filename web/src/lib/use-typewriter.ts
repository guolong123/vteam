/**
 * useTypewriter：客户端逐字揭示（流式正文 / 进行中推理的 progressive reveal）
 * =============================================
 * 复用于私聊流式「生成中」行的多行正文与思考中（pending）单行跑马灯：返回 `target` 的
 * **渐进前缀**，永不长于 target。
 *
 * 设计前提：serve 的 reasoning / text delta 是**粗粒度块**（数百字符、数秒一批），
 * 因此这里不是字节流复刻，而是客户端「追帧」——无论目标文本何时到达，都会在
 * catchUpSeconds 级别内追上「当前已知全文」，随后静默等待下一批。
 *
 * 契约：
 * - requestAnimationFrame 驱动，每帧至多一次 setState（不整帧空转）；
 * - 自适应速率：rate = clamp(backlog / catchUpSeconds, minCps, maxCps)，
 *   backlog = target.length - revealed.length（积压越多越快，恒能追上）；
 * - target 增长（纯延长）→ 继续推进；target 缩短 / 换身份 → 直接吸附到当前 target
 *   （不回退动画，不撕裂）；
 * - `prefers-reduced-motion: reduce` → 直接到位（返回 target）；
 * - 卸载 / 依赖变化时取消未决动画帧与 matchMedia 监听，无泄漏。
 *
 * SSR 安全：初始态恒为 ""（服务端与客户端首帧一致，无 hydration 失配）；首帧后在
 * effect 中启动揭示。
 */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export interface TypewriterOptions {
  /** 最低速率（字符/秒）：细粒度到达时也保留可感知的逐字节奏。默认 24。 */
  minCps?: number;
  /** 最高速率（字符/秒）：避免一次大积压时突兀闪全。默认 600。 */
  maxCps?: number;
  /** 追上当前积压的目标时长（秒）：backlog / catchUpSeconds 决定速率。默认 1。 */
  catchUpSeconds?: number;
}

const DEFAULT_MIN_CPS = 24;
const DEFAULT_MAX_CPS = 600;
const DEFAULT_CATCH_UP_SECONDS = 1;

/** `prefers-reduced-motion: reduce` 判定（SSR / 无 matchMedia 环境恒 false）。 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * 返回 `target` 的渐进揭示前缀（≤ target）。target 首次种入即从空串逐字补齐，
 * 后续每次增长继续追赶；缩短/换身份直接吸附。
 */
export function useTypewriter(target: string, opts: TypewriterOptions = {}): string {
  const minCps = opts.minCps ?? DEFAULT_MIN_CPS;
  const maxCps = opts.maxCps ?? DEFAULT_MAX_CPS;
  const catchUpSeconds = opts.catchUpSeconds ?? DEFAULT_CATCH_UP_SECONDS;

  const [revealed, setRevealed] = useState("");
  const revealedRef = useRef("");
  const targetRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  /** 小数进度累计：低速率下 rate*dt < 1 时逐帧累积，避免 floor 归零导致永不推进。 */
  const accRef = useRef(0);
  const configRef = useRef({ minCps, maxCps, catchUpSeconds });
  configRef.current = { minCps, maxCps, catchUpSeconds };

  const cancel = useCallback((): void => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTsRef.current = null;
    accRef.current = 0;
  }, []);

  const snapTo = useCallback((value: string): void => {
    revealedRef.current = value;
    setRevealed(value);
  }, []);

  useEffect(() => {
    const prevTarget = targetRef.current;
    targetRef.current = target;

    // reduced-motion：直接到位，不启动动画。
    if (prefersReducedMotion()) {
      cancel();
      if (revealedRef.current !== target) snapTo(target);
      return;
    }

    // 缩短 / 换身份（非「前一个 target 的纯延长」）→ 吸附，不回退。
    const isExtension =
      target.length >= prevTarget.length && target.startsWith(prevTarget);
    if (!isExtension) {
      cancel();
      if (revealedRef.current !== target) snapTo(target);
      return;
    }

    // 防御：已揭示长度越界（target 变短但被判为延长的极端）→ 吸附。
    if (revealedRef.current.length > target.length) {
      cancel();
      snapTo(target);
      return;
    }
    if (revealedRef.current.length >= target.length) {
      return; // 已追平：无需动画，等 target 再增长由本 effect 重启
    }

    const tick = (ts: number): void => {
      rafRef.current = null;
      const current = targetRef.current;
      const count = Math.min(revealedRef.current.length, current.length);
      if (count >= current.length) {
        lastTsRef.current = null;
        if (revealedRef.current !== current) snapTo(current);
        return; // 追平：停止循环
      }
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      const dt = last === null ? 0 : Math.max(0, ts - last) / 1000;
      const { minCps: lo, maxCps: hi, catchUpSeconds: windowSec } = configRef.current;
      const backlog = current.length - count;
      const rate = Math.min(hi, Math.max(lo, backlog / Math.max(windowSec, 0.001)));
      accRef.current += rate * dt;
      const whole = Math.floor(accRef.current);
      if (whole > 0) {
        accRef.current -= whole;
        const nextCount = Math.min(current.length, count + whole);
        snapTo(current.slice(0, nextCount));
        if (nextCount >= current.length) {
          lastTsRef.current = null;
          return; // 追平：停止循环
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return cancel;
  }, [target, cancel, snapTo]);

  // reduced-motion 运行期切换为 reduce：立刻吸附到位。
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => {
      if (!mq.matches) return;
      cancel();
      const current = targetRef.current;
      if (revealedRef.current !== current) snapTo(current);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [cancel, snapTo]);

  return revealed;
}
