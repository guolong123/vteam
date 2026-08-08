# C5a 实测证据：opencode auth.json 注入机制

> 计划：model-management.md todo 8（C5a 前置实测）
> 日期：2026-08-08
> opencode 版本：1.18.15（`/home/keta/.opencode/bin/opencode`）
> 环境：Linux（本机）
> 状态：**实测完成，结论已定型，可写入 C5 实现**

## 1. auth.json 精确路径（实测结论）

opencode 1.18.15 解析 auth.json 的路径优先级（**实测 3 次实验验证**）：

```
$XDG_DATA_HOME/opencode/auth.json        ← 最高优先级（XDG 规范路径）
$HOME/.local/share/opencode/auth.json    ← 回退路径（默认，无 XDG_DATA_HOME 时）
```

**决定性证据（实验 3）**：同时设置 `HOME` 和 `XDG_DATA_HOME` 指向不同测试目录时，
`opencode auth list` 显示 `/tmp/opencode-test/xdgA/opencode/auth.json`（XDG 路径胜出），
证明 `$XDG_DATA_HOME` 优先级严格高于 `$HOME/.local/share`。

**strace 铁证（实验 9b）**：`XDG_DATA_HOME=/tmp/opencode-test/xdg-real opencode serve`，
strace 显示 serve 进程实际执行：

```
openat(AT_FDCWD, "/tmp/opencode-test/xdg-real/opencode/auth.json", O_RDONLY|O_NOCTTY) = 13
```

即 serve 子进程真实读取 `$XDG_DATA_HOME/opencode/auth.json`，非编译期假设。

## 2. 格式（实测）

`auth.json` 顶层为 providerID → 凭据对象的 map：

```json
{
  "<providerID>": {
    "type": "api",
    "key": "<API_KEY>"
  }
}
```

本机 `/home/keta/.local/share/opencode/auth.json` 实测：9 个 provider，
全部 `type: "api"` 结构（deepseek / xiaomi / minimax-cn / xiaomi-token-plan-cn / bailing /
alibaba-cn / opencode-go / alibaba-token-plan / alibaba-token-plan-cn）。
凭据在 auth.json 中为明文 key（文件权限 600 是唯一防线）。

## 3. 自定义路径支持（实测结论）

| 方式 | 结果 |
|------|------|
| `opencode serve --config <path>` | ❌ **不支持**。`opencode serve --help` 与 `opencode --help` 均无 `--config` 参数（1.18.15） |
| `HOME` env 覆盖 | ✅ 生效。实验 1：`HOME=/tmp/opencode-test/homeA opencode auth list` 读到 homeA 的 auth.json（显示 `~/.local/share/opencode/auth.json`） |
| `XDG_DATA_HOME` env 覆盖 | ✅ 生效（且优先）。实验 2/3：读到 `$XDG_DATA_HOME/opencode/auth.json` |

**结论**：opencode 无显式 `--config` 指向 auth.json 的能力；但 `HOME` 或 `XDG_DATA_HOME`
env 均可将 auth.json 读取位置重定向到任意（worker 可写）路径。这是 C5 唯一无需映射的注入通道。

## 4. serve 加载凭据的实证（对照组实验）

- **实验 8**（注入路径含真实 provider `deepseek`，key 为测试占位值）：
  `XDG_DATA_HOME=/tmp/opencode-test/xdg-real opencode models deepseek` →
  成功列出 4 个 deepseek 模型（deepseek-chat / deepseek-reasoner / deepseek-v4-flash / deepseek-v4-pro）
- **实验 8b**（对照，空 auth.json）：
  `opencode models deepseek` → `Error: Provider not found: deepseek`

**铁证结论**：auth.json 存在与否直接决定 provider 是否可用。写入正确格式的 auth.json
= provider 立即可被 `opencode models` / serve 识别；缺失则 provider not found。
这证明 worker 侧注入 auth.json 是**可行且充分**的通道。

- **实验 6**：`opencode models`（不带 provider）输出 opencode 内置 free 模型（与 auth.json 无关），
  验证时须带 provider 参数区分。

## 5. 无 auth.json 的降级行为（实验 4/5）

- `HOME=/tmp/opencode-test/homeB`（无 auth.json）`opencode auth list` → 0 credentials，不报错
- `HOME=/tmp/opencode-test/nonexist`（目录不存在）→ 同样 0 credentials，不报错

**结论**：无 auth.json 时 opencode 静默降级（provider not found），不影响 serve 启动。
C5 失败态（未下发凭据）不会让 worker 崩，仅模型不可用。

## 6. 注入方式最终结论（写死进 C5）

**主选方案**：
```
worker 进程启动时设置 env: XDG_DATA_HOME=<worker-data-dir>
写文件: <worker-data-dir>/opencode/auth.json
格式:   { providerID: { type: 'api', key: '<token>' } }
权限:   0o600（mkdir -p + writeFileSync + chmodSync 0o600）
```

- **选 XDG_DATA_HOME 而非 HOME**：优先级更高（实验 3），且不改动 HOME 的其他语义
  （opencode config、日志、session 等仍走原 HOME），注入面最小、副作用可控。
- **serve 子进程继承**：`spawnServe` env = `{...process.env}`（opencode-server.ts:282），
  设置一次进程级 env，serve spawn 时自动继承，**无需改动 spawnServe 签名**。
- **cwd 无关**：serve 的 cwd 默认 process.cwd()（opencode-server.ts:286），
  实测 auth.json 读取仅依赖 env 路径解析，与 cwd 无关。
- **重启链路已具备**：`restart()`（opencode-server.ts:201-206）= stop + start，
  C5 写 auth.json 后调 restart 即让新凭据生效，无需额外机制。

## 7. 补充：实验命令记录

```bash
# 准备测试目录
mkdir -p /tmp/opencode-test/homeA/.local/share/opencode /tmp/opencode-test/xdgA/opencode
# 实验 1（HOME 覆盖）
HOME=/tmp/opencode-test/homeA opencode auth list
# 实验 2/3（XDG_DATA_HOME 优先）
HOME=/tmp/opencode-test/homeB XDG_DATA_HOME=/tmp/opencode-test/xdgA opencode auth list
# 实验 8（注入真实 provider 加载验证）
HOME=/tmp/opencode-test/homeB XDG_DATA_HOME=/tmp/opencode-test/xdg-real opencode models deepseek
# 实验 8b（对照组）
HOME=/tmp/opencode-test/homeB XDG_DATA_HOME=/tmp/opencode-test/xdg-empty opencode models deepseek
# 实验 9b（strace 铁证）
timeout 6 strace -f -e trace=openat opencode serve --port 48325 2>/tmp/strace.log
grep auth.json /tmp/strace.log
```

## 8. 安全说明

- 本文档未包含任何真实 key 值；测试用 key 均为占位字符串（`sk-...-dummy`）。
- 本机 auth.json 仅以 python 打印 provider 键名与 `type`，key 仅断言 SET/UNSET，未输出。
- 实测用测试目录全部位于 `/tmp/opencode-test/`（临时），不触碰本机凭据。
