"use client";

/**
 * Markdown：安全 markdown 渲染组件（is_0000000019）
 * =============================================================
 * - 基于 react-markdown + remark-gfm（表格/删除线/自动链接等 GFM 语法）。
 * - 安全：react-markdown 默认**不渲染 raw HTML**（原样转义展示），
 *   且默认 urlTransform 仅放行 http/https/mailto/tel 与相对路径
 *   （javascript: 等危险协议被剥离）→ 满足「禁止 raw HTML 注入，防 XSS」。
 * - 样式：`.md-render` 作用域 CSS（table/pre/code/blockquote/标题/列表/链接等），
 *   表格超宽横向滚动，不破坏外层气泡布局。
 * - 仅用于 agent 消息正文（用户/系统消息仍走纯文本，见 ChatBubble）。
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** .md-render 作用域样式（表格/代码块/列表/标题/引用/链接等）。 */
const mdStyles = `
.md-render {
  white-space: normal;
  word-break: break-word;
  line-height: 1.6;
  font-size: inherit;
}
.md-render > :first-child { margin-top: 0; }
.md-render > :last-child { margin-bottom: 0; }
.md-render p { margin: .4em 0; }
.md-render h1, .md-render h2, .md-render h3,
.md-render h4, .md-render h5, .md-render h6 {
  margin: .8em 0 .4em;
  font-weight: 600;
  line-height: 1.35;
}
.md-render h1 { font-size: 1.4em; }
.md-render h2 { font-size: 1.25em; }
.md-render h3 { font-size: 1.1em; }
.md-render h4, .md-render h5, .md-render h6 { font-size: 1em; }
.md-render ul, .md-render ol { margin: .4em 0; padding-left: 1.5em; }
.md-render li { margin: .15em 0; }
.md-render a { color: #2563EB; text-decoration: underline; word-break: break-all; }
.md-render blockquote {
  margin: .5em 0;
  padding: .2em .9em;
  border-left: 3px solid #CBD5E1;
  color: #64748B;
}
.md-render code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .9em;
  background: #F1F5F9;
  border-radius: 4px;
  padding: .1em .35em;
}
.md-render pre {
  margin: .6em 0;
  padding: .7em 1em;
  border-radius: 8px;
  background: #0F172A;
  color: #E2E8F0;
  overflow-x: auto;
}
.md-render pre code {
  background: transparent;
  color: inherit;
  padding: 0;
  font-size: .88em;
}
.md-render table {
  margin: .6em 0;
  border-collapse: collapse;
  max-width: 100%;
  display: block;
  overflow-x: auto;
}
.md-render th, .md-render td {
  border: 1px solid #CBD5E1;
  padding: .3em .6em;
  text-align: left;
}
.md-render th {
  background: #F8FAFC;
  font-weight: 600;
}
.md-render hr { border: none; border-top: 1px solid #CBD5E1; margin: .8em 0; }
.md-render img { max-width: 100%; border-radius: 6px; }
`;

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md-render" data-testid="markdown-render">
      <style>{mdStyles}</style>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
