/**
 * v2-tool-plugin.ts — MINIMAL v2 custom tool, proven to be loaded AND invoked by a real
 * opencode v2.0.28 serve (see ../evidence/t5-run.txt).
 *
 * Place at:  <project>/.opencode/plugins/<name>.ts
 *
 * v2 facts this file encodes (all verified by experiment, see the spike report):
 *  - tools are registered ONLY through `ctx.tool.transform(...)`; `.opencode/tools/*.ts`
 *    auto-discovery does NOT exist in v2.
 *  - `input` is plain JSON Schema (not Zod).
 *  - `execute` returns `{ content }` (not a bare string).
 *  - `options: { codemode: false }` is REQUIRED for the model to call the tool directly.
 *    Without it the tool is only reachable through the `execute` (Code Mode) tool.
 *  - the ToolContext passed to `execute` is { sessionID, agent, messageID, id, signal, progress }.
 *    There is NO `directory` in it.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "vteam-tools",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "spike_probe",
        description: "Spike probe tool. Returns a fixed marker plus the v2 ToolContext keys.",
        input: {
          type: "object",
          properties: { note: { type: "string", description: "optional note" } },
          required: [],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => ({
          content: JSON.stringify({
            marker: "SPIKE_PROBE_OK",
            input,
            ctxKeys: Object.keys(context).sort(),
            sessionID: context.sessionID,
            agent: context.agent,
            messageID: context.messageID,
            callID: context.id,
            hasDirectory: Object.prototype.hasOwnProperty.call(context, "directory"),
          }),
        }),
      })
    })
  },
})
