#!/usr/bin/env node
/**
 * P0 mock MCP server（streamable-http）：
 * 暴露一个 vteam_like 工具，验证 DSH 能否挂载并调用外部 MCP。
 * 实现 MCP 的最小 JSON-RPC over HTTP：POST /mcp（initialize / tools/list / tools/call）。
 */
const http = require('node:http')

const PORT = Number(process.env.MCP_PORT || 18900)
const TOOL_NAME = process.env.MCP_TOOL || 'vteam_like'

const PROTOCOL_VERSION = '2025-06-18'

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const json = (obj, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'mock-session-1',
      })
      res.end(JSON.stringify(obj))
    }
    let msg
    try { msg = JSON.parse(body) } catch { return json(rpcError(null, -32700, 'parse error'), 400) }

    if (msg.method === 'initialize') {
      console.log('[mcp] initialize')
      return json(rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'vteam-mock-mcp', version: '0.0.1' },
      }))
    }
    if (msg.method === 'notifications/initialized') {
      console.log('[mcp] initialized notification')
      res.writeHead(202); res.end(); return
    }
    if (msg.method === 'tools/list') {
      console.log('[mcp] tools/list')
      return json(rpcResult(msg.id, {
        tools: [{
          name: TOOL_NAME,
          description: 'Like a message in the vteam platform (mock).',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'text to like' } },
            required: ['text'],
          },
        }],
      }))
    }
    if (msg.method === 'tools/call') {
      console.log('[mcp] tools/call', JSON.stringify(msg.params?.arguments))
      return json(rpcResult(msg.id, {
        content: [{ type: 'text', text: `liked: ${msg.params?.arguments?.text ?? ''}` }],
      }))
    }
    if (msg.method === 'ping') return json(rpcResult(msg.id, {}))
    return json(rpcError(msg.id, -32601, `unknown method ${msg.method}`))
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`[mcp] listening ${PORT} tool=${TOOL_NAME}`))
