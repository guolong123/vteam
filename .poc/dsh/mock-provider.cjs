#!/usr/bin/env node
/**
 * P0 mock provider：一个最小 OpenAI 兼容 SSE 端点（/v1/chat/completions）。
 * 目的：不依赖真实凭据，验证 DSH 的完整链路：
 *   - assistant/message 事件是否带 usage（input/output/thought 拆分）
 *   - turn/end reason.kind
 *   - tool_calls 工具调用事件形状
 *   - 流式 committed 粒度
 */
const http = require('node:http')

const PORT = Number(process.env.MOCK_PORT || 18777)
const PORT2 = Number(process.env.MOCK_PORT2 || 18778)

function sse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

// 场景 1：纯文本回答（带 usage）
// 场景 2：工具调用
const MODE = process.env.MOCK_MODE || 'text'

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }],
      }))
      return
    }
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404); res.end('{}'); return
    }
    // 延迟可配：用于测 cancel
    const delay = Number(process.env.MOCK_DELAY_MS || 0)
    const doStream = () => {
      if (MODE === 'tool') {
        // 完整一轮：tool_call → tool 结果由 agent 回灌 → 最终文本
        sse(res, [
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'mcp__vteam__vteam_like', arguments: JSON.stringify({ text: 'hello from POC' }) } }] }, finish_reason: null }] },
          { id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 } },
        ])
      } else {
        sse(res, [
          { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' }, finish_reason: null }] },
          { id: 'c2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 101, completion_tokens: 7, total_tokens: 108, prompt_tokens_details: { cached_tokens: 5 } } },
        ])
      }
    }
    if (delay > 0) setTimeout(doStream, delay)
    else doStream()
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`[mock] listening ${PORT} mode=${MODE}`))
