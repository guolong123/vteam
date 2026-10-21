# OpenCode v2 热重载（hot-reload）**实测证据**

> 本目录是 `docs/agent-platform/opencode-v2-自研机制与v2原生能力对照.md` §2.3 **U-a** 项
> （"自动文件热重载的原始证据未入库"）的**闭环交付物**：把此前只存在于调查轮现场记录里的
> 结论，变成**可复现、可核对、逐条带原始输出**的证据文件。
>
> 被它支撑的实现：`worker/src/reload/config-reloader.ts` · `worker/src/reload/pending-requests.ts`
> （结局词表：`reloaded` / `deferred` / `failed` / `unverified`）。

---

## 0. 一句话结论

**opencode v2 有两条零重启的配置生效路径**（实测 v2.0.28）：

| 路径 | 手段 | 效果 | 代价 |
|---|---|---|---|
| **文件监听**（默认开启） | 改 `<workDir>/opencode.json` / `.opencode/skills/**` / `.opencode/plugins/**` / 隔离全局 `opencode.json` | 秒级自动生效，**serve PID 不变**、会话不断、**不取消任何待答复项** | 生效**异步**（实测 200~350 ms） |
| **显式原语** | `POST /api/location/reload` → **204** | **立刻**重建所有 location，serve PID 不变、会话存活 | ⚠️ **会取消所有 location 的 pending 表单与权限请求**；重建本身**异步**（204 之后还有 ~100 ms 滞后） |

⇒ 两条路径**互为备份**：有 pending 时走文件监听（安全），没有 pending 时走 `location/reload`（确定性）。

---

## 1. 实测环境与版本（**务必分清**）

| 项 | 值 |
|---|---|
| **实测二进制** | `opencode v2.0.28`（`/Users/mac/.opencode/bin/opencode`，`opencode --version` → `opencode v2.0.28`） |
| **锁定版本** | `@opencode/cli@2.0.32`（`worker/Dockerfile` 的 `ARG OPENCODE_CLI_SPEC`）——**本目录的证据不是 2.0.32 的** |
| 采集日期 | 2026-10-20（UTC） |
| 宿主 | macOS 26.5.1 (arm64) · Node v24.14.0（`repro.mjs` 用 node 内置 `fetch`，无第三方依赖） |
| 隔离 | `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` **全部**指向临时目录 |
| 临时目录 | `$TMPDIR/opencode/hot-reload-<stamp>/`（本机即 `/private/var/folders/0y/1xtzqt_j3_g_1yff3gnkfsgc0000gn/T/opencode/…`）——**不在仓库里** |
| 鉴权 | `OPENCODE_SERVER_PASSWORD=hotreloadpass`（Basic，username 恒为 `opencode`） |
| 凭据 | **不需要任何 provider 凭据、不连外网**（MCP server 用脚本内生成的本地 stdio 假实现） |
| 收尾 | 脚本杀掉自己起的 serve（进程组 TERM → 等 → KILL），收尾打印 `pgrep -fl "opencode serve"` 供人工核对 |

> ⚠️ **版本口径**：`docs/agent-platform/opencode-v2-contract-baseline/` 也是 **2.0.28** 的快照，
> 同样不是锁版目标的快照。**锁版即锁证据**（见 §5 的 2.0.32 复检清单）。

---

## 2. 怎么复现

```bash
cd docs/agent-platform/opencode-v2-hot-reload-evidence
node repro.mjs            # 产出本目录下的 11 个 NN-*.txt
```

- 需要：真的 opencode v2 二进制（默认 `/Users/mac/.opencode/bin/opencode`）+ node ≥ 18。
  可用 `OPENCODE_BIN=... node repro.mjs` 换二进制；`OUT_DIR=/tmp/xx node repro.mjs` 换输出目录。
- 脚本**每次都用全新的临时目录**（不会复用上一次的状态），跑完把 scratch 路径打在 stdout 上。
- 脚本**只写本目录下的 11 个证据文件**（文本），**不写仓库其它地方**、**不碰宿主机 HOME**。
- 等价的最小手工命令（逐条对应证据文件）：

```bash
# 起 serve（隔离 env）
export SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/opencode/hotreload.XXXXXX")
mkdir -p "$SCRATCH"/{home/.config,home/.local/share,proj/.opencode/plugins,proj/.opencode/skills}
( cd "$SCRATCH/proj" && HOME="$SCRATCH/home" XDG_CONFIG_HOME="$SCRATCH/home/.config" \
  XDG_DATA_HOME="$SCRATCH/home/.local/share" OPENCODE_SERVER_PASSWORD=hotreloadpass \
  opencode serve --port 45993 --hostname 127.0.0.1 --print-logs --log-level debug \
  > "$SCRATCH/serve.log" 2>&1 & )
PW=hotreloadpass; A=http://127.0.0.1:45993
curl -s -u "opencode:$PW" -X POST "$A/api/session" -H 'content-type: application/json' \
  -d "{\"location\":{\"directory\":\"$SCRATCH/proj\"}}"     # location 是惰性的：先建会话

# 01 改 agents.<name>.system → 只 GET 读回（不发任何触发调用）
node -e "const f='$SCRATCH/proj/opencode.json';const d=JSON.parse(require('fs').readFileSync(f));d.agents['hotreload-agent'].system='SYSTEM_V2_MARKER';require('fs').writeFileSync(f,JSON.stringify(d,null,2))"
curl -s -u "opencode:$PW" -G "$A/api/agent/hotreload-agent" --data-urlencode "location[directory]=$SCRATCH/proj"

# 07 显式重载：204 / PID 不变 / 会话存活
pgrep -f "opencode serve --port 45993"
curl -s -o /dev/null -w '%{http_code}\n' -u "opencode:$PW" -X POST "$A/api/location/reload"
pgrep -f "opencode serve --port 45993"

# 收尾
pkill -f "opencode serve --port 45993"
```

> ⚠️ **location 参数的写法**：v2 的 location 选择是 **deepObject 风格**的
> `location[directory]=<dir>`；用 `curl --data-urlencode`（或 node 的 `URLSearchParams`）会把
> `[` `]` 编成 `%5B` `%5D`，**这是 v2 能识别的形式**。
> ⚠️ 另外：**location 是惰性加载的**——某个目录的 location 没被"拉起来"之前，
> 显式指定它的查询会**静默回落到默认 location**（实测），而该 location 的权限评估也会因为
> 没有 agent 规则而落到 `deny`。所以脚本里对任务子目录先等 `GET /api/location` 解析成功、
> 再等 `GET /api/agent` 里出现目标 agent，才开始造 pending 项（见 08 的 header）。

---

## 3. 目录内容（artifact → 它支撑的结论）

| 文件 | 测了什么 | 它支撑的结论 |
|---|---|---|
| `01-config-edit-agent-system.txt` | 改项目 `opencode.json` 的 `agents.<name>.system`，**只发 GET** 读回 | 角色提示的载体 `agents.<name>.system` **改文件即生效**（本次实测 311 ms），**不需要任何触发调用**（窗口内 0 次 POST） |
| `02-mcp-server-added.txt` | 往项目 `opencode.json` 加 `mcp.servers.<name>` | MCP server **改文件即生效**（本次实测 211 ms 出现、随即 `connected`），**不需要任何触发调用** |
| `03-skill-added.txt` | 新增 `.opencode/skills/<name>/SKILL.md` | skill **新增即生效**（**目录级 watcher**，`type=directory backend=fs-events`） |
| `04-plugin-added.txt` | 新增 `.opencode/plugins/<f>.ts`，其 `setup()` 写 marker | 插件**新增即被加载**：`setup()` 被调用（marker 出现，本次 306 ms）+ serve 日志 `msg="loading plugin"` |
| `05-plugin-edited-in-place.txt` | **原地编辑**同一个插件文件（`fs.writeFileSync`，**不 unlink / 不 rename**） | ⭐ **原地编辑也会重新触发 `setup()`**（marker 计数 1→2，本次 205 ms）——**这正是 vteam 注入器依赖的那一行** |
| `06-global-config-isolated.txt` | 改**隔离的全局配置** `$XDG_CONFIG_HOME/opencode/opencode.json`（加一个带 `settings.apiKey` 的 provider） | **隔离域的全局配置同样热重载**：新 provider 出现在 `GET /api/provider` / `GET /api/model`（无需触发调用） |
| `07-location-reload.txt` | `POST /api/location/reload`：状态码、重载前后 **serve PID**、重载后会话可读性、**重建滞后** | 显式原语可用：**204**、**PID 不变**（进程没重启）、**会话存活**；⚠️ **重建是异步的**：204 之后 **+24 ms 的单次读读到的是旧快照**，新值 **+123 ms** 才可见 ⇒ **必须有界 settle 窗口** |
| `08-pending-cancelled-by-reload.txt` | 造 pending form + pending permission（**默认 location 与任务子目录各一套**），再 `location/reload` | ⚠️ **`location/reload` 取消 pending**（form 与 permission 都取消）；⚠️ **`GET /api/form` / `GET /api/permission/request` 是 location 作用域的**（默认 location 查不到任务子目录的待答复项），而 reload 取消的是**所有 location** ⇒ **闸门必须逐会话查** |
| `09-pending-survives-without-reload.txt` | **对照组**：造 pending form + pending permission，**什么都不做**等 8 s | pending 项**自然存活**（8 s 后仍在）⇒ 08 里的消失**只能**归因于 reload ⇒ **pending 闸门是必需的**（`deferred` 分支有存在理由） |
| `10-pending-preserved-by-file-watcher.txt` | 有 pending 项时改配置文件（**只走文件监听路径**） | 文件监听路径**不取消任何待答复项**（form 与 permission 的 id 前后一致）⇒ 这就是 `deferred` 分支的落点 |
| `11-no-watcher-switch.txt` | 本次全部热重载的配置里**没有 `watcher` 键**；另实测写 `watcher:{"enabled":false}` 会被静默丢弃 | **不需要任何 watcher 开关**：v2 的 `watcher` 段**只有 `ignore`**（`additionalProperties:false`），热重载是**默认开启**的行为 |
| `repro.mjs` | —— | **复现入口**（生成上面 11 个文件的脚本本身；无第三方依赖） |

---

## 4. 两条**实现相关**的事实（**不要在后续改动里弄丢它们**）

这两条是 `worker/src/reload/config-reloader.ts` / `pending-requests.ts` 的设计前提，
由本目录的 07 / 08 两条证据直接支撑。**后来的维护者必须知道它们，否则会引入"静默销毁用户正在作答的问题"这类最不可接受的 bug。**

### 4.1 `GET /api/form` / `GET /api/permission/request` 是 **location 作用域**的 ⇒ 闸门必须**逐会话**查

- **实测**（08）：会话放在**任务子目录**时，
  - `GET /api/form`（**不带** location ⇒ 默认 location = serve 的 cwd = workDir）→ **查不到**它的待答复表单；
  - `GET /api/form?location[directory]=<任务子目录>` → 只看得到**该 location** 的表单；
  - `GET /api/session/{id}/form` → **看得到**（与 location 无关）。
- **同时**（08）：`POST /api/location/reload` 取消的是**所有 location** 的 pending（两个 location 的 form 与 permission **都**被清空）。
- ⇒ **用默认 location 的全局端点当闸门 = 漏判**（真有待答复项却放行重载）= **静默销毁用户正在作答的问题**。
  ⇒ 闸门必须**逐会话**查（`GET /api/session/{id}/form` 与 `GET /api/session/{id}/permission`）——
  这正是 `pending-requests.ts` 里 `detectPendingRequests()` 的做法。

### 4.2 `location/reload` 之后的重建是**异步**的 ⇒ 必须有**有界 settle 窗口**

- **实测**（07）：`POST /api/location/reload` 返回 204 之后，**紧接着的那一次读**（距 204 仅 **24 ms**）**读到的是旧快照**；
  新值在 **+123 ms** 才可见（另一次采集为 **+88 ms**）。
- ⇒ **单次校验读会误判"未生效"** ⇒ 会触发**不必要的真实重启**（端口漂移 ⇒ 静默断线）。
- ⇒ 效果确认必须在一个**有界**窗口内**重试**（`config-reloader.ts` 的 `settleMs`，默认 2000 ms、约 10 次读），
  **不是长轮询**（配置变更不该变成一个长任务）。
- ⚠️ 顺带实测：`location/reload` **本身**要花 **~2.0 s** 才返回 204（它要等所有 location 的替换构建落定），
  所以重载请求的超时要给足（`config-reloader.ts` 的 `timeoutMs` 默认 10 s）。

---

## 5. ⚠️ 锁版目标是 **2.0.32**，本目录的证据全部来自 **2.0.28** ⇒ 下面这些**必须在 2.0.32 上复检**

**2.0.28 实测行为 vs 锁版 2.0.32** 的差异**尚未验证**。复检清单（锁版后跑一遍 `repro.mjs` 即可）：

1. **`location/reload` 的取消语义**（pending form / permission 被取消）——
   **若 2.0.32 不再取消，则实现的闸门可以从"defer（改走文件监听）"放宽成"直接重载"**，
   `deferred` 分支的可退化空间随之改变。⚠️ 这是**闸门策略**的版本依赖点。
2. **2.0.32 是否仍在**所有** location 上取消 pending**（本目录 08 是在 2 个 location 上验的）。
3. **重载后的重建滞后**（2.0.28 实测 ~100 ms：单次读 24 ms 读到旧快照、新值 123 ms 可见）——
   实现的 settle 窗口（2000 ms）就是按这个量级取的；**若 2.0.32 的滞后显著变大**，窗口要重估。
4. **六条文件监听行**在 2.0.32 上逐条复检（01/02/03/04/05/10）：
   `agents.<name>.system` · `mcp.servers.<name>` · `.opencode/skills/<name>/SKILL.md` ·
   `.opencode/plugins/<f>.ts` 新增 · ⭐ **原地编辑插件（无 unlink）→ `setup()` 再次被调用** ·
   **有 pending 时改配置 → pending 被保留**。
   **尤其第 5 条**（原地编辑 → `setup()` 重入）——这是 **vteam 注入器真正依赖的那一行**，
   一旦 2.0.32 改成"只有 unlink/rename 才重载"，注入器的产物落盘方式就要跟着改。
5. **`deferred` 分支在真实 2.0.32 栈上的行为**（pending 项存在 ⇒ **既不重载**、**pending 又存活**）——
   本目录 10 只证明了"文件监听路径不取消 pending"，**没有**在 2.0.32 上端到端跑过
   "有 pending ⇒ 重载被跳过 ⇒ pending 存活"这条完整链路。
6. （附带）**`settings.apiKey` 在 2.0.32 的 provider 响应里是否仍然明文回显**（见 §6）。

---

## 6. 与预期不符的一处：`apiKey` **没有**被脱敏

任务书预期"`apiKey` 值本身在 provider 响应里是**脱敏**的，因此证据只证明**可见性**"。
**实测（2.0.28）不是这样**：

- `GET /api/provider` / `GET /api/provider/{id}` / `GET /api/model` 都**明文回显** `settings.apiKey`
  （见 06 的原始响应）。
- ⇒ 本目录的证据**顺带**证明了"apiKey 的值原样回显"这件事，而不只是"可见性"。
- ⚠️ 证据里的 key 是**合成的假串**（`sk-hot-reload-PROBE-NOT-A-REAL-KEY` / `sk-lag-PROBE-NOT-A-REAL-KEY`），
  **不是任何真实凭据**；真实 key 绝不能进仓库。
- ⚠️ **2.0.32 是否脱敏尚未验证**（见 §5 第 6 条）——若 2.0.32 改成脱敏，本目录这条结论要重写。

---

## 7. 其它实测到的细节（顺带记一笔）

- **location 是惰性加载的**：不给某个目录建会话，那个目录的 location 不会起来；
  此时对该目录的 location 查询会**静默回落到默认 location**，权限评估也会落到 `deny`。
- **插件按 location 加载**（与计划 §10 Q18 一致）：同一个插件文件在两个 location 下会被 `setup()` 两次。
  本目录的 04/05 里 marker 计数是 `1 → 2`，是因为**每次重建都会重新 `setup()`**，
  而不是"两个 location 各一次"——采集时任务子目录的 location 还没起来。
- **serve 日志**里能直接看到热重载的重建过程：`message="watcher stopped"/"watcher started"`、
  `message="skill source loaded"`、`msg="loading plugin"`、以及 `config.updated` / `agent.updated` /
  `provider.updated` / `model.updated` / `command.updated` 事件。
- **`watcher` 段只认 `ignore`**：写 `watcher:{"enabled":false}` 会被**静默丢弃**（归一化后是 `{}`），
  **连 `configuration normalization diagnostic` 告警都没有** ⇒ **没有"关掉热重载"的旋钮**。
- **`GET /api/location`** 可以用来确认"某个目录的 location 解析成了它自己"（响应里的 `directory`），
  比轮询业务端点更直接。

---

## 8. 关联文档

| 文档 | 关系 |
|---|---|
| `docs/agent-platform/opencode-v2-自研机制与v2原生能力对照.md` | §2.3 **U-a** 指向本目录；§3.4 R4 / §5.1 🥇 的"✅ 已确证"由本目录支撑 |
| `docs/agent-platform/opencode-v2-contract-baseline/` | 同为 **2.0.28** 产出（不是锁版 2.0.32） |
| `.omo/plans/opencode-v2-adaptation.md` | §10 的 **U11**（`location/reload` 在 2.0.32 的行为）与 **U12**（逐项实测并入库）由本目录部分回答 |
| `.omo/plans/opencode-v2-progress.md` | 证据入库的进度记录 |
| `worker/src/reload/config-reloader.ts` · `worker/src/reload/pending-requests.ts` | 被本目录支撑的实现 |
