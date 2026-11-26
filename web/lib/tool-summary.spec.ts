import { expect, test } from "@playwright/test";
import {
  isGroupPostTool,
  summarizeToolInput,
  summarizeToolOutput,
  toolOutputLineCount,
  toolProducedMessageIds,
  toolTitleOf,
} from "./tool-summary";

test("MCP 工具标题显示实际 server.tool 名称，兼容 Code Mode 包装", () => {
  expect(toolTitleOf("mcp__vteam__group_post")).toBe("vteam.group_post");
  expect(toolTitleOf("vteam_group_post")).toBe("vteam.group_post");
  expect(toolTitleOf("mcp__vteam__notify_agent")).toBe("vteam.notify_agent");
  expect(
    toolTitleOf(
      "execute",
      'const r = await tools.vteam.group_post({ content: "long content" });',
    ),
  ).toBe("vteam.group_post");
  expect(isGroupPostTool("mcp__vteam__group_post")).toBe(true);
  expect(isGroupPostTool("bash", "echo group_post")).toBe(false);
});

test("工具输出 messageId 用于识别 group_post / notify_agent 的群消息投影", () => {
  const ids = toolProducedMessageIds([
    {
      content: {
        parts: [
          {
            type: "tool",
            tool: "mcp__vteam__group_post",
            state: { output: '{"messageId":"m_group"}' },
          },
          {
            type: "tool",
            tool: "execute",
            state: {
              input: "await tools.vteam.notify_agent({})",
              output: { messageId: "m_notify" },
            },
          },
          {
            type: "tool",
            tool: "execute",
            state: {
              input: "const lines = [ ...truncated... ];",
              output: {
                messageId: "m_exec_group",
                channelId: "c_1",
                attachment: null,
              },
            },
          },
          {
            type: "tool",
            tool: "bash",
            state: { output: '{"messageId":"m_other"}' },
          },
        ],
      },
    },
  ]);
  expect([...ids].sort()).toEqual(["m_exec_group", "m_group", "m_notify"]);
});

test("工具标题在 native 与 DSH 使用同一套紧凑文案", () => {
  expect(toolTitleOf("bash")).toBe("运行命令");
  expect(toolTitleOf("vteam_run_command")).toBe("运行命令");
  expect(toolTitleOf("read")).toBe("读取");
  expect(toolTitleOf("vteam_task_context")).toBe("vteam_task_context");
});

test("参数摘要优先提取 command/path，不展示裸 JSON", () => {
  expect(
    summarizeToolInput('{"description":"列出文件","command":"ls -la /data"}'),
  ).toBe("ls -la /data");
  expect(summarizeToolInput('{"file_path":"/data/a.ts","content":"hello"}')).toBe("/data/a.ts");
  expect(summarizeToolInput('["a.ts","b.ts"]')).toBe("a.ts b.ts");
});

test("非 JSON 取首行并压缩空白，空输入不占位", () => {
  expect(summarizeToolInput("echo one\necho two")).toBe("echo one");
  expect(summarizeToolInput("  echo   one  ")).toBe("echo one");
  expect(summarizeToolInput("{}")).toBe("");
  expect(summarizeToolInput("[]")).toBe("");
  expect(summarizeToolInput("   ")).toBe("");
});

test("超长摘要封顶 96 字符，避免过程行换行撑高", () => {
  const summary = summarizeToolInput("x".repeat(120));
  expect(summary).toHaveLength(97);
  expect(summary.endsWith("…")).toBe(true);
});

test("输出只统计实际行数，忽略首尾空行并兼容 CRLF", () => {
  expect(toolOutputLineCount("")).toBe(0);
  expect(toolOutputLineCount(" \n ")).toBe(0);
  expect(toolOutputLineCount("ok")).toBe(1);
  expect(toolOutputLineCount("one\ntwo\n")).toBe(2);
  expect(toolOutputLineCount(" one\r\n\r\ntwo \r\n")).toBe(3);
});

test("无输入摘要时优先提炼最后的汇总/成功/失败结果", () => {
  expect(
    summarizeToolOutput(
      "MCP-5 PASS grouped mode: tools=['cve'], operations=7\n\n汇总: 32/32 PASS -> /tmp/result.md",
    ),
  ).toBe("汇总: 32/32 PASS -> /tmp/result.md");
  expect(summarizeToolOutput("noise\nError: boom")).toBe("Error: boom");
  expect(summarizeToolOutput("<content>\nfirst line\nsecond line\n</content>")).toBe("first line");
  expect(summarizeToolOutput(" \n ")).toBe("");
  expect(summarizeToolOutput("x".repeat(3000))).toBe("");
});

test("输出摘要同样封顶 96 字符", () => {
  const summary = summarizeToolOutput("x".repeat(120));
  expect(summary).toHaveLength(97);
  expect(summary.endsWith("…")).toBe(true);
});
