import { expect, test } from "@playwright/test";
import { findActiveStreamingPart } from "./streaming-parts";

test("reasoning 单独在流式消息末尾时才保持思考中", () => {
  const reasoning = { id: "r1", type: "reasoning", text: "正在推理" };
  expect(findActiveStreamingPart([reasoning], true, "reasoning")).toBe(reasoning);
  expect(findActiveStreamingPart([reasoning], false, "reasoning")).toBeUndefined();
});

test("reasoning 后面出现工具或正文后立即收敛为已完成", () => {
  const reasoning = { id: "r1", type: "reasoning", text: "已经推理完" };
  const runningTool = { id: "t1", type: "tool", state: { status: "running" } };
  const doneTool = { id: "t1", type: "tool", state: { status: "completed" } };
  const text = { id: "x1", type: "text", text: "开始输出正文" };

  expect(findActiveStreamingPart([reasoning, runningTool], true, "reasoning")).toBeUndefined();
  expect(findActiveStreamingPart([reasoning, doneTool], true, "reasoning")).toBeUndefined();
  expect(findActiveStreamingPart([reasoning, text], true, "reasoning")).toBeUndefined();
});

test("新的末尾 reasoning 才是当前思考，旧 reasoning 不保持运行态", () => {
  const oldReasoning = { id: "r1", type: "reasoning", text: "旧思考" };
  const tool = { id: "t1", type: "tool", state: { status: "completed" } };
  const activeReasoning = { id: "r2", type: "reasoning", text: "新思考" };

  expect(
    findActiveStreamingPart([oldReasoning, tool, activeReasoning], true, "reasoning"),
  ).toBe(activeReasoning);
});

test("显式 done/time.end 的 reasoning 不再显示思考中", () => {
  expect(
    findActiveStreamingPart([{ type: "reasoning", text: "完成", state: "done" }], true, "reasoning"),
  ).toBeUndefined();
  expect(
    findActiveStreamingPart([{ type: "reasoning", text: "完成", time: { end: 1 } }], true, "reasoning"),
  ).toBeUndefined();
});

test("正文后面出现工具或思考时，正文不再显示生成中", () => {
  const text = { id: "x1", type: "text", text: "第一段" };
  const tool = { id: "t1", type: "tool", state: { status: "running" } };
  const reasoning = { id: "r1", type: "reasoning", text: "继续想" };

  expect(findActiveStreamingPart([text, tool], true, "text")).toBeUndefined();
  expect(findActiveStreamingPart([text, reasoning], true, "text")).toBeUndefined();
  expect(findActiveStreamingPart([text], true, "text")).toBe(text);
});
