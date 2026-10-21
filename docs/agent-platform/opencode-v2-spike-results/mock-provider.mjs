#!/usr/bin/env node
/**
 * mock-provider.mjs — credential-free OpenAI-compatible mock provider for opencode v2 spikes.
 *
 * - Listens on 127.0.0.1:$MOCK_PORT (default 45981)
 * - Implements POST /v1/chat/completions (streaming + non-streaming) and GET /v1/models
 * - Records EVERY incoming request body to $MOCK_OUT as JSONL  (this is how we prove
 *   what actually reaches the model)
 *
 * Behaviour is driven by the last user message:
 *   "__TOOL__:<toolName>:<jsonArgs>"   -> reply with a tool_call for that tool
 *   "__EXECUTE__:<js code>"            -> reply with a tool_call for the `execute` (Code Mode) tool
 *   anything else                      -> reply with plain text "MOCK_OK"
 * A tool call is only emitted once per turn (if the conversation already contains a
 * tool result after the last user message, the mock answers with plain text) so that
 * a mis-registered tool cannot produce an infinite tool-call loop.
 */
import { createServer } from "node:http"
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const PORT = Number(process.env.MOCK_PORT || 45981)
const OUT = process.env.MOCK_OUT || "/tmp/opencode-spike-requests.jsonl"
const HOST = process.env.MOCK_HOST || "127.0.0.1"

try {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, "")
} catch {}

let seq = 0

function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role === "user") {
      const c = m.content
      if (typeof c === "string") return c
      if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("\n")
    }
  }
  return ""
}

function plan(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  const text = lastUserText(body)
  let lastUser = -1
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") { lastUser = i; break }
  if (msgs.slice(lastUser + 1).some((x) => x?.role === "tool")) return { kind: "text", text: "MOCK_OK" }
  const ex = /__EXECUTE__:\s*([\s\S]+)$/.exec(text)
  if (ex) return { kind: "tool", name: "execute", args: JSON.stringify({ code: ex[1].trim() }) }
  const m = /__TOOL__:\s*([A-Za-z0-9_.-]+)\s*:\s*(\{[\s\S]*?\})/.exec(text)
  if (m) return { kind: "tool", name: m[1], args: m[2] }
  return { kind: "text", text: "MOCK_OK" }
}

function json(res, obj, status = 200) {
  const s = JSON.stringify(obj)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) })
  res.end(s)
}

function chunk(id, model, delta, finish = null) {
  return { id, object: "chat.completion.chunk", created: 1700000000, model, choices: [{ index: 0, delta, finish_reason: finish }] }
}

const server = createServer((req, res) => {
  let raw = ""
  req.on("data", (d) => (raw += d))
  req.on("end", () => {
    if (req.method === "GET" && (req.url || "").includes("/models")) {
      return json(res, { object: "list", data: [{ id: "spike-model", object: "model", created: 1700000000, owned_by: "spike" }] })
    }
    if (req.method !== "POST" || !(req.url || "").includes("/chat/completions")) {
      return json(res, { error: { message: "mock: unsupported " + req.method + " " + req.url } }, 404)
    }
    let body
    try {
      body = JSON.parse(raw || "{}")
    } catch (e) {
      return json(res, { error: { message: "mock: bad json: " + e.message } }, 400)
    }
    const n = ++seq
    try {
      appendFileSync(OUT, JSON.stringify({ n, url: req.url, headers: req.headers, body }) + "\n")
    } catch (e) {
      console.error("mock: cannot record request:", e.message)
    }
    const p = plan(body)
    const model = body.model || "spike-model"
    const id = "chatcmpl-mock-" + n

    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n")
      if (p.kind === "tool") {
        send(chunk(id, model, { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_" + n, type: "function", function: { name: p.name, arguments: p.args } }] }))
        send(chunk(id, model, {}, "tool_calls"))
      } else {
        send(chunk(id, model, { role: "assistant", content: p.text }))
        send(chunk(id, model, {}, "stop"))
      }
      send({ id, object: "chat.completion.chunk", created: 1700000000, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      res.write("data: [DONE]\n\n")
      return res.end()
    }

    const message =
      p.kind === "tool"
        ? { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_mock_" + n, type: "function", function: { name: p.name, arguments: p.args } }] }
        : { role: "assistant", content: p.text }
    return json(res, {
      id, object: "chat.completion", created: 1700000000, model,
      choices: [{ index: 0, message, finish_reason: p.kind === "tool" ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  })
})

server.listen(PORT, HOST, () => console.log(`mock provider listening on http://${HOST}:${PORT} (recording -> ${OUT})`))
process.on("SIGTERM", () => server.close(() => process.exit(0)))
process.on("SIGINT", () => server.close(() => process.exit(0)))
