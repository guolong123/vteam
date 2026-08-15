/**
 * PostCSS 配置（is_0000000037）：@tailwindcss/postcss（Tailwind v4，PostCSS 方式）
 * - 为移植的 md-docs 原型（src/components/docs/prototypes/，使用 tailwind 工具类）生成工具类；
 * - 全局 preflight 保持（web globals.css 手动 reset 已对齐 Tailwind preflight，见其注释）；
 * - brand/success 等主题色经 globals.css @theme 定义（对齐 prototype-viewer index.css）。
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
