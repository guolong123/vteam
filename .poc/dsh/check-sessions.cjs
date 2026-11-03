// 检查会话路由与结果（容器内用）
const zlib = require('zlib');
const fs = require('fs');

const files = process.argv.slice(2);
for (const f of files) {
  let out = '';
  try {
    out = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');
  } catch (e) {
    console.log(f, 'decompress failed');
    continue;
  }
  let route = '';
  let end = '';
  let asst = 0;
  let text = '';
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'request/context') {
      route = String(j.data?.provider) + '/' + String(j.data?.model);
    }
    if (j.type === 'turn/end') {
      end = String(j.data?.reason?.kind ?? '');
    }
    if (j.type === 'assistant/message') {
      asst++;
      for (const b of j.data?.message?.content ?? []) {
        if (b.type === 'text') text = b.text;
      }
    }
  }
  const name = f.split('/').slice(-2)[0].slice(0, 20);
  console.log(name, '| route=' + route, '| end=' + end, '| asst=' + asst, '|', JSON.stringify(text).slice(0, 70));
}
