/**
 * dual-shape-plugin.ts — ONE artefact that works on OpenCode v1 AND v2.
 *
 * Verified by experiment on BOTH binaries that ship on this machine:
 *   v1: /Users/mac/.opencode/bin/opencode.v1.18.32.bak  -> calls `server()`, tool ran
 *   v2: /Users/mac/.opencode/bin/opencode (v2.0.28)     -> calls `setup(ctx)`, ignores `server()`
 * Evidence: ../evidence/t5-dualv1.txt
 *
 * Shape (matches the official v2 plugin-migration guide, "Support V1 and V2 from one package"):
 *   export default { ...Plugin.define({ id, setup(ctx) }), async server() { ... } }
 *
 * IMPORTANT CAVEAT found by experiment: on v1 the `setup(ctx)` key is ALSO invoked
 * (with v1's plugin context, where `ctx.tool` does not exist). The v2 branch must
 * therefore be defensive: bail out when the v2-only API is missing, otherwise v1
 * throws inside setup (harmless but noisy). `Plugin.define` is the identity function
 * in @opencode/plugin 2.0.32, so the spread is cosmetic — but we keep it so the
 * module reads exactly like the official guide.
 *
 * The v1 branch needs `@opencode-ai/plugin` for `tool()`. It does NOT need a
 * node_modules install: the v1 binary provides the module to plugins from its own
 * bundle (verified: the scratch project had no node_modules and the import still
 * resolved).
 */
import { Plugin } from "@opencode/plugin"

export default {
  ...Plugin.define({
    id: "vteam-dual",
    async setup(ctx: any) {
      // v2 branch — bail out when running under v1 (ctx.tool is undefined there)
      if (!ctx?.tool?.transform) return
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "dual_probe",
          description: "dual-shape probe tool",
          input: { type: "object", properties: { n: { type: "string" } }, required: [], additionalProperties: false },
          options: { codemode: false },
          execute: async (input: any) => ({ content: "DUAL_V2_OK " + JSON.stringify(input) }),
        })
      })
    },
  }),
  async server() {
    // v1 branch — returns the v1 plugin shape: { tool: { <name>: tool({...}) } }
    const { tool } = await import("@opencode-ai/plugin")
    return {
      tool: {
        dual_probe: tool({
          description: "dual-shape probe tool",
          args: { n: tool.schema.string().optional() },
          async execute(args: any) {
            return "DUAL_V1_OK " + JSON.stringify(args)
          },
        }),
      },
    }
  },
}
