# OpenCode v2 热重载（hot-reload）**实测证据**

> 本目录是 `docs/agent-platform/opencode-v2-自研机制与v2原生能力对照.md` §2.3 **U-a** 项
> （"自动文件热重载的原始证据未入库"）的**闭环交付物**：把此前只存在于调查轮现场记录里的
> 结论，变成**可复现、可核对、逐条带原始输出**的证据文件。
>
> 被它支撑的实现：`worker/src/reload/config-reloader.ts` · `worker/src/reload/pending-requests.ts`
> （结局词表：`reloaded` / `deferred` / `failed` / `unverified`）。

---

## 0. 一句话结论

**opencode v2 有两条零重启的配置生效路径**（实测 **v2.0.32**＝锁版）：

| 路径 | 手段 | 效果 | 代价 |
|---|---|---|---|
| **文件监听**（默认开启） | 改 `<workDir>/opencode.json` / `.opencode/skills/**` / `.opencode/plugins/**` / 隔离全局 `opencode.json` | 秒级自动生效，**serve PID 不变**、会话不断、**不取消任何待答复项** | 生效**异步**（3 轮实测区间 205 ~ 919 ms，见 §5.3） |
| **显式原语** | `POST /api/location/reload` → **204** | **立刻**重建所有 location，serve PID 不变、会话存活 | ⚠️ **会取消所有 location 的 pending 表单与权限请求**；重建本身**异步**（204 之后还有 3 轮实测区间 98 ~ 376 ms 的滞后，见 §5.3） |

⇒ 两条路径**互为备份**：有 pending 时走文件监听（安全），没有 pending 时走 `location/reload`（确定性）。

---

## 1. 实测环境与版本（**务必分清**）

| 项 | 值 |
|---|---|
| **实测二进制** | `opencode v2.0.32`——**容器内**的 `/usr/local/bin/opencode`（软链到 `../lib/node_modules/@opencode/cli/bin/opencode.exe`），`opencode --version` → `opencode v2.0.32`；serve 自报 `GET /api/info` → `{"version":"2.0.32",...}` |
| **镜像** | `vteam-worker:latest`（sha256:b4a46ba1cd23…）＝**本仓库 `worker/Dockerfile` 构建**，`ARG OPENCODE_CLI_SPEC=@opencode/cli@2.0.32` ⇒ **锁版即锁证据**（**行为证据**口径：这份行为证据本身就是锁版产物；**契约形态快照**另算，见 §8） |
| **运行位置** | **容器内**（`docker compose run --rm --no-deps`，一次性容器，**不触碰**运行中的 worker/server/web/db） |
| 容器平台 | Linux aarch64（`node:22-bookworm-slim`）· Node **v22.23.3**（脚本用 node 内置 `fetch`，无第三方依赖） |
| 宿主平台 | macOS 26.5.1 (arm64)——**只**用来跑 `docker compose`；**宿主二进制 `/Users/mac/.opencode/bin/opencode` 是 2.0.28 的 darwin/arm64 原生程序**，2.0.32 是 **linux ELF**，二者不能互换 ⇒ 2.0.32 的复现**必须在容器里做** |
| 采集日期 | 2026-10-21（UTC 04:51~05:23） |
| 隔离 | `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` **全部**指向临时目录 |
| 临时目录 | 容器内 `/tmp/opencode/hot-reload-<stamp>/`——**不在仓库里**（宿主看不到，随容器销毁） |
| 鉴权 | `OPENCODE_SERVER_PASSWORD=hotreloadpass`（Basic，username 恒为 `opencode`） |
| 凭据 | **不需要任何 provider 凭据、不连外网**（MCP server 用脚本内生成的本地 stdio 假实现；12 号证据用的口令/token 全是**抛掷用的假串**） |
| 收尾 | 脚本杀掉自己起的 serve（进程组 TERM → 等 → KILL），收尾打印 `pgrep -fl "opencode serve"` 供人工核对 |

> 📌 **历史**：本目录最初的一套 `01~11` 证据是在 **2.0.28**（宿主 darwin/arm64 二进制）上采的，
> **原件保留在 git 历史里**（未删、未另存副本）；**2.0.28 → 2.0.32 的逐条对比与复检结论见 §5**。
> ⚠️ **版本口径**：`docs/agent-platform/opencode-v2-contract-baseline/` **仍是 2.0.28 的快照**，
> 那部分不属于本目录的交付范围。

---

## 2. 怎么复现

### 2.1 主路径（**已验证可用**）：在容器里跑 `repro.mjs`

> ⚠️ 2.0.32 是 **linux ELF**，宿主上的 2.0.28 是 darwin/arm64 原生程序 ⇒
> **在宿主直接 `node repro.mjs` 跑不出本目录这套证据**（默认 `OPENCODE_BIN` 指的正是宿主那个 2.0.28）。
> 必须在**本仓库 `worker/Dockerfile` 构建出的镜像**里跑（那个镜像才带着 `@opencode/cli@2.0.32`）。

```bash
cd /Volumes/SSD-Data/01work/git-project/vteam-v2
mkdir -p /tmp/v2-recheck-2032
cp docs/agent-platform/opencode-v2-hot-reload-evidence/repro.mjs /tmp/v2-recheck-2032/
docker compose run --rm --no-deps \
  -v /tmp/v2-recheck-2032:/evidence \
  -e OPENCODE_BIN=/usr/local/bin/opencode \
  -e OUT_DIR=/evidence \
  worker node /evidence/repro.mjs
```

预期输出：`opencode: opencode v2.0.32` + scratch 路径 + **11 行 `wrote NN-*.txt`** + 收尾
`pgrep -fl "opencode serve"` 为**空**（无残留 serve 进程）。产物落在 `/tmp/v2-recheck-2032/`，
与本目录的 `01~11` **同名同格式**（逐条对比见 §5）。

- `OPENCODE_BIN` **必须**显式指到容器内的 `/usr/local/bin/opencode`；
  `OUT_DIR` 用来决定产物落哪儿（`/evidence` 即挂载出来的宿主目录）。
- 脚本**每次都用全新的临时目录**（不会复用上一次的状态），跑完把 scratch 路径打在 stdout 上。
- 脚本**只写 `OUT_DIR` 下的 11 个证据文件**（文本），**不写仓库其它地方**、**不碰宿主机 HOME**。

### 2.2 复现 12 号证据（`deferred` 闸门端到端）

```bash
cd /Volumes/SSD-Data/01work/git-project/vteam-v2
# ① 起一次性 worker 容器（独立模式：不注册/不心跳 ⇒ 不依赖平台）
docker compose run --rm --no-deps -d \
    -e X_WORKER_TOKEN=probe-token-deferred-2026 \
    -e WORKER_STANDALONE=true \
    -e OPENCODE_SERVER_PASSWORD=probe-serve-pw-deferred \
    -e WORKER_ID=w_probe_deferred \
    -e WORKER_EXEC_PORT=4199 \
    -e OPENCODE_SERVE_PORT=18099 \
    -e OPENCODE_SERVE_HOSTNAME=0.0.0.0 \
    -e WORK_DIR=/scratch/work \
    -e HOME=/scratch/home \
    -e OPENCODE_ISOLATION_ROOT=/scratch/iso \
    -e SERVER_URL=http://127.0.0.1:9 \
    -e WORKER_CODE_VERSION=probe-deferred-e2e \
    -e LOG_LEVEL=info \
    -p 127.0.0.1:4199:4199 -p 127.0.0.1:18099:18099 \
    -v /tmp/vteam-deferred-probe/scratch:/scratch \
    worker
# ② 跑采集脚本（node 内置 fetch，无第三方依赖）
node docs/agent-platform/opencode-v2-hot-reload-evidence/repro-deferred.mjs
```

> 脚本把原始请求/响应写进它硬编码的 `OUT`（`/tmp/vteam-deferred-probe/evidence.txt`），
> 并在最后一节自动汇总判定（A~E 五条）。
> **12 号证据文件**＝`header`（版本 / 镜像 / 容器 / 命令，见文件头）
> ＋ `evidence.txt`（全部原始请求/响应 + 汇总判定）
> ＋ **附 A**：worker 容器自己的日志（`docker logs <一次性容器>`，闸门判定的原文）
> ＋ **附 B**：serve 端侧对照表（`location/reload` 全量重建的痕迹 = `watcher stopped` 条数）
> ＋ **附 C**：收尾核对（无残留 serve 进程 / 无残留容器 / 线上栈仍健康）。
> ⚠️ 脚本里的 `WORKER`/`SERVE` 端口（4199 / 18099）与 `/tmp/vteam-deferred-probe/scratch` 挂载点
> 是**采集时**的取值，重跑时按需改这几个常量（都在脚本头部）。

### 2.3 等价的最小手工命令（逐条对应证据文件）

> 下面是**手工等价**命令（在**容器内**执行；二进制用 `opencode`＝容器内 2.0.32）。

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

> 下表"本次实测"列 = **入库这一轮**（2.0.32，2026-10-21 04:51~04:52）的数值；
> 多轮之间的抖动与最坏值见 §5.4。

| 文件 | 测了什么 | 它支撑的结论 |
|---|---|---|
| `01-config-edit-agent-system.txt` | 改项目 `opencode.json` 的 `agents.<name>.system`，**只发 GET** 读回 | 角色提示的载体 `agents.<name>.system` **改文件即生效**（本次实测 712 ms），**不需要任何触发调用**（窗口内 0 次 POST） |
| `02-mcp-server-added.txt` | 往项目 `opencode.json` 加 `mcp.servers.<name>` | MCP server **改文件即生效**（本次实测 219 ms 出现、随即 `connected`），**不需要任何触发调用** |
| `03-skill-added.txt` | 新增 `.opencode/skills/<name>/SKILL.md` | skill **新增即生效**（**目录级 watcher**，`type=directory`，容器 linux 下 `backend=inotify`） |
| `04-plugin-added.txt` | 新增 `.opencode/plugins/<f>.ts`，其 `setup()` 写 marker | 插件**新增即被加载**：`setup()` 被调用（marker 出现，本次 207 ms）+ serve 日志 `msg="loading plugin"` |
| `05-plugin-edited-in-place.txt` | **原地编辑**同一个插件文件（`fs.writeFileSync`，**不 unlink / 不 rename**） | ⭐ **原地编辑也会重新触发 `setup()`**（marker 计数 1→2，本次 305 ms）——**这正是 vteam 注入器依赖的那一行** |
| `06-global-config-isolated.txt` | 改**隔离的全局配置** `$XDG_CONFIG_HOME/opencode/opencode.json`（加一个带 `settings.apiKey` 的 provider） | **隔离域的全局配置同样热重载**：新 provider 出现在 `GET /api/provider` / `GET /api/model`（无需触发调用，本次 221 ms） |
| `07-location-reload.txt` | `POST /api/location/reload`：状态码、重载前后 **serve PID**、重载后会话可读性、**重建滞后** | 显式原语可用：**204**、**PID 不变**（进程没重启）、**会话存活**；⚠️ **重建是异步的**：204 之后 **+62 ms 的单次读读到的是旧快照**，新值 **+223 ms** 才可见 ⇒ **必须有界 settle 窗口** |
| `08-pending-cancelled-by-reload.txt` | 造 pending form + pending permission（**默认 location 与任务子目录各一套**），再 `location/reload` | ⚠️ **`location/reload` 取消 pending**（form 与 permission 都取消）；⚠️ **`GET /api/form` / `GET /api/permission/request` 是 location 作用域的**（默认 location 查不到任务子目录的待答复项），而 reload 取消的是**所有 location** ⇒ **闸门必须逐会话查** |
| `09-pending-survives-without-reload.txt` | **对照组**：造 pending form + pending permission，**什么都不做**等 8 s | pending 项**自然存活**（8 s 后仍在）⇒ 08 里的消失**只能**归因于 reload ⇒ **pending 闸门是必需的**（`deferred` 分支有存在理由） |
| `10-pending-preserved-by-file-watcher.txt` | 有 pending 项时改配置文件（**只走文件监听路径**） | 文件监听路径**不取消任何待答复项**（form 与 permission 的 id 前后一致）⇒ 这就是 `deferred` 分支的落点 |
| `11-no-watcher-switch.txt` | 本次全部热重载的配置里**没有 `watcher` 键**；另实测写 `watcher:{"enabled":false}` 会被静默丢弃 | **不需要任何 watcher 开关**：v2 的 `watcher` 段**只有 `ignore`**（`additionalProperties:false`），热重载是**默认开启**的行为 |
| `12-deferred-gate-end-to-end.txt` | **端到端**：worker 的**真实 `ConfigReloader`** 对着**真实 2.0.32 serve**，在**有 pending**（默认 location + 任务子目录各一套 form+permission，共 4 项）时 `POST /config/reload` | ✅ **`deferred` 分支在 2.0.32 上成立**：同一入口返回 **`{"reload":"deferred"}`**；**四个 pending id 全部存活**（不变）；配置变更**仍然生效**（走文件监听路径，`GET /api/agent/<name>` 读回新的 `system`）；**对照组**（答复掉四项后）同一入口返回 **`{"reload":"reloaded"}`** 且 serve 日志出现**全量 location 重建**；**反证**：直接 `POST /api/location/reload` ⇒ pending 被**取消**（204 → 两条列表都空）⇒ 闸门**不是冗余**的 |
| `repro.mjs` | —— | **复现入口**（生成 01~11 的脚本本身；无第三方依赖） |
| `repro-deferred.mjs` | —— | **复现入口**（生成 12 的脚本本身；node 内置 `fetch`，无第三方依赖） |

---

## 4. 两条**实现相关**的事实（**不要在后续改动里弄丢它们**）

这两条是 `worker/src/reload/config-reloader.ts` / `pending-requests.ts` 的设计前提，
由本目录的 07 / 08 两条证据直接支撑（**2.0.32 上复检后结论不变**，见 §5）。
**后来的维护者必须知道它们，否则会引入"静默销毁用户正在作答的问题"这类最不可接受的 bug。**

### 4.1 `GET /api/form` / `GET /api/permission/request` 是 **location 作用域**的 ⇒ 闸门必须**逐会话**查

- **实测**（08，2.0.32）：会话放在**任务子目录**时，
  - `GET /api/form`（**不带** location ⇒ 默认 location = serve 的 cwd = workDir）→ **查不到**它的待答复表单；
  - `GET /api/form?location[directory]=<任务子目录>` → 只看得到**该 location** 的表单；
  - `GET /api/session/{id}/form` → **看得到**（与 location 无关）。
- **同时**（08，2.0.32）：`POST /api/location/reload` 取消的是**所有 location** 的 pending（两个 location 的 form 与 permission **都**被清空）。
- ⇒ **用默认 location 的全局端点当闸门 = 漏判**（真有待答复项却放行重载）= **静默销毁用户正在作答的问题**。
  ⇒ 闸门必须**逐会话**查（`GET /api/session/{id}/form` 与 `GET /api/session/{id}/permission`）——
  这正是 `pending-requests.ts` 里 `detectPendingRequests()` 的做法。
  （12 号证据在真实 worker 上又验了一遍同一件事：默认 location 的全局端点查不到任务子目录的 pending。）

### 4.2 `location/reload` 之后的重建是**异步**的 ⇒ 必须有**有界 settle 窗口**

- **实测**（07，2.0.32）：`POST /api/location/reload` 返回 204 之后，**紧接着的那一次读**
  （距 204 **62 ms**）**读到的是旧快照**；新值在 **+223 ms** 才可见。
  （2.0.28 上同一条是：单次读 +24 ms 读旧、新值 +123 ms 可见；多轮 2.0.32 的最坏值见 §5.3。）
- ⇒ **单次校验读会误判"未生效"** ⇒ 会触发**不必要的真实重启**（端口漂移 ⇒ 静默断线）。
- ⇒ 效果确认必须在一个**有界**窗口内**重试**（`config-reloader.ts` 的 `settleMs`，默认 2000 ms、约 10 次读），
  **不是长轮询**（配置变更不该变成一个长任务）。
  **2000 ms 这个窗口在 2.0.32 上仍然够用**（最坏实测 ~376 ms ⇒ 余量 ~5.3×），**不必重估**。
- ⚠️ 顺带实测：`location/reload` **本身**要花 **2126 ~ 2432 ms**（入库这一轮 **2216 ms**）才返回 204（它要等所有 location 的替换构建落定），
  所以重载请求的超时要给足（`config-reloader.ts` 的 `timeoutMs` 默认 10 s）。

---

## 5. ✅ **2.0.32 复检已完成**（逐条判定）

**锁版目标是 `@opencode/cli@2.0.32`，本目录的证据现在全部来自 2.0.32。**
下面 6 条复检清单**全部跑完**，结论逐条记录如下（**行为判定**）：

| # | 复检项 | 判定 | 观察到的依据 |
|---|---|---|---|
| 1 | **`location/reload` 的取消语义**（pending form / permission 被取消） | ✅ **仍取消** | 08（2.0.32）：`POST /api/location/reload` → 204 之后，**两个 location 的 form 与 permission 全部被清空**（取消前各 1 条 → 取消后 0 条）。⇒ **闸门策略不变**，`deferred` 分支**仍有存在理由**；12 号证据的反证段再验一次（直接打 `location/reload` ⇒ pending 被取消） |
| 2 | 是否仍在**所有** location 上取消 | ✅ **是** | 08：默认 location + 任务子目录**各一套** pending，reload 之后**两套都被取消**，现象与 2.0.28 **一致** |
| 3 | **重建滞后** | ⚠️ **放大约 3×**，但**仍在窗口内** | 07：单次读**仍读到旧快照**（2.0.28 +24 ms → 2.0.32 +62 ms，多轮最坏 +137 ms）；新值可见 **+123 ms（2.0.28）→ +223 ms（入库这一轮）/ +376 ms（三轮最坏值）** ⇒ **仍在 2000 ms settle 窗口内**（最坏余量约 **5.3×**）⇒ **窗口不必重估**（详见 §5.3） |
| 4 | **六条文件监听行**（01/02/03/04/05/10） | ✅ **全部一致** | 01 改 `agents.<name>.system` 生效；02 MCP server 出现；03 新增 skill 生效；04 新增插件 → `setup()` 被调用；05 **原地编辑插件 → `setup()` 重入**；10 有 pending 时改配置 → pending 保留。⭐ **第 5 条仍然成立**：marker 计数 **1 → 2**，**入库这一轮 305 ms**（2.0.28 为 205 ms；2.0.32 **3 轮实测区间 205 ~ 305 ms**，见 §5.3）⇒ **vteam 注入器依赖的那一行没变** |
| 5 | **`deferred` 分支端到端** | ✅ **已验证** | **12 号证据**：真实 worker 的 `ConfigReloader` × 真实 2.0.32 serve ⇒ `POST /config/reload` 返回 **`{"reload":"deferred"}`**、**四个 pending id 存活不变**、**配置变更仍生效**（文件监听路径）；答复掉四项后同一入口返回 **`{"reload":"reloaded"}`** 且 serve 日志出现**全量 location 重建**（`watcher stopped` 19 条 vs 延后路径的 4 条） |
| 6 | `settings.apiKey` 是否明文回显 | ⚠️ **2.0.32 仍明文回显** | 06（2.0.32）：`GET /api/provider` / `GET /api/provider/{id}` / `GET /api/model` 都返回**原样的 `settings.apiKey`** ⇒ **§6 的结论在锁版上依然成立** |

⇒ **总判定：实现（`worker/src/reload/config-reloader.ts`）当初按 2.0.28 观察到的行为写的假设，
在锁版 2.0.32 上**全部成立** ⇒ 这项"版本依赖"**不再是开放风险**。**

### 5.1 两套证据的**逐条断言**对比（2.0.28 vs 2.0.32）

把 2.0.28 的 11 个 artifact 与 2.0.32 的 11 个 artifact 做**归一化对比**
（抹掉端口 / pid / session-id / event-id / 时间戳 / 路径 / 耗时数字）：

- ✅ **全部行为断言逐条一致**（HTTP 状态码、pending 的存/亡、marker 计数 1→2、
  "窗口内 0 次 POST"、"watcher 段只认 ignore"、apiKey 明文回显……）。
- 差异**只有**三类：① 标识符（session / form / permission / event id）、② 耗时数字、
  ③ 二进制与路径（`/Users/mac/.opencode/bin/opencode` → 容器内 `/usr/local/bin/opencode`）。
- ⇒ **行为没有变，只有时序数字变了**。

### 5.2 复检的**判定**里唯一值得记一笔的**非行为**变化

- **文件监听行的数量与顺序完全一致**，但**目录 watcher 的后端**随平台变：
  宿主 macOS 是 `backend=fs-events`，容器 linux 是 `backend=inotify`
  （03 的 header 里就是 `inotify`）⇒ **平台差异，不是版本差异**，语义相同（目录级监听）。

### 5.3 ⏱ **时延变化**（2.0.28 → 2.0.32）与 2000 ms settle 窗口的余量

| 观测点 | 2.0.28 | 2.0.32（**入库这一轮**） | 2.0.32（多轮实测范围） | 对 2000 ms 窗口的余量 |
|---|---|---|---|---|
| 01 `agents.<name>.system` 新值可见 | 311 ms | **712 ms** | 337 ~ 712 ms（2 轮有记录） | ≥ 2.8× |
| 02 MCP server 出现 | 211 ms | **219 ms** | 214 ~ 397 ms | ≥ 5.0× |
| 04 **插件新增 → `setup()` 首次调用** | 306 ms | **207 ms** | **207 ~ 919 ms** | 6.4× → **最坏仅 2.2×** ⚠️ |
| 05 插件原地编辑 → `setup()` 重入 | 205 ms | **305 ms** | 205 ~ 305 ms | ≥ 6.5× |
| 06 隔离全局配置 → 新 provider | 209 ms | **221 ms** | 221 ~ 373 ms | ≥ 5.3× |
| 07 `location/reload` → 新值可见（重建滞后） | 123 ms | **223 ms** | **98 ~ 376 ms** | 16.3× → **最坏 5.3×** |
| 07 `location/reload` 请求耗时（到 204） | 2028 ms | **2216 ms** | 2126 ~ 2432 ms | ——（**不占用** settle 窗口：它在返回**之前**就已落定） |
| 08 `location/reload` 请求耗时（带 pending） | 2563 ms | **2934 ms** | 2934 ~ 3423 ms | —— |

- ⚠️ **抖动很大**：同一个探针在 2.0.32 上连跑三轮，耗时能差 3~4 倍
  （插件 `setup()`：207 / 504 / **919** ms；重建滞后：223 / 98 / **376** ms）——
  容器里 CPU/IO 争抢是主因。**所以下面的余量按"最坏值"算，不用单轮数字下结论。**
- ✅ **窗口仍然够用**：最坏实测 919 ms（插件路径）/ 376 ms（重建滞后），
  对实现的 **2000 ms settle 窗口**分别是 **2.2×** 与 **5.3×** 余量 ⇒ **窗口不必重估**。
- ⚠️ **唯一要盯的**：**plugin 路径**的余量从 **6.4×** 缩到了**最坏 2.2×** ⇒ **后续升级 opencode 时必须重量这一条**
  （`config-reloader.ts` 的 `settleMs` 默认 2000 ms；一旦插件 `setup()` 首次调用逼近 2 s，
  就要么调大窗口、要么改成"读到自己写的目标值才算生效"）。

### 5.4 📌 复检的**采集轮次**说明（为什么 §3 表里是 712 ms，而 §5.3 里还有 337 ms）

- 2.0.32 上共跑了 **3 轮** `repro.mjs`：**入库这一轮**（UTC 04:51~04:52，产物即本目录 01~11）
  + 另两轮（UTC 04:29 前后 / 04:47~04:48）。3 轮的**行为断言完全一致**，只有耗时不同。
- 本目录只保留**入库这一轮**的产物（11 个文件，不留第二份副本）；2.0.28 的原件在 **git 历史**里。
- 12 号证据是**独立的一次运行**（UTC 05:22~05:23），走的是 worker 的真实 `ConfigReloader`。

---

## 6. 与预期不符的一处：`apiKey` **没有**被脱敏

任务书预期"`apiKey` 值本身在 provider 响应里是**脱敏**的，因此证据只证明**可见性**"。
**实测（2.0.32）不是这样**（**2.0.28 与 2.0.32 一样**）：

- `GET /api/provider` / `GET /api/provider/{id}` / `GET /api/model` 都**明文回显** `settings.apiKey`
  （见 06 的原始响应；06 里那句判定文本里的版本号由脚本**从运行中的二进制自动取**，不再写死）。
- ⇒ 本目录的证据**顺带**证明了"apiKey 的值原样回显"这件事，而不只是"可见性"。
- ⚠️ 证据里的 key 是**合成的假串**（`sk-hot-reload-PROBE-NOT-A-REAL-KEY` / `sk-lag-PROBE-NOT-A-REAL-KEY`），
  **不是任何真实凭据**；真实 key 绝不能进仓库。
  （12 号证据里的 serve 口令 `probe-serve-pw-deferred` 与 worker token `probe-token-deferred-2026`
  同样是**抛掷用的假串**。）

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
- ⚠️ **判断 `location/reload` 到底有没有被调用，要看 serve 日志里的 `watcher stopped` 条数**：
  **文件监听路径只停本地监听**（少），**`location/reload` 才会做全量 location 重建**（多）。
  12 号证据里：延后（deferred）路径 `watcher stopped` **4 条**，对照（reloaded）路径 **19 条**。
  ⇒ **只看 HTTP 状态码（204）分辨不出这两条路径**，必须数日志行。
- **`watcher` 段只认 `ignore`**：写 `watcher:{"enabled":false}` 会被**静默丢弃**（归一化后是 `{}`），
  **连 `configuration normalization diagnostic` 告警都没有** ⇒ **没有"关掉热重载"的旋钮**。
- **`GET /api/location`** 可以用来确认"某个目录的 location 解析成了它自己"（响应里的 `directory`），
  比轮询业务端点更直接。
- **平台相关的 watcher 后端**：目录级 watcher 在 macOS 宿主上是 `backend=fs-events`，
  在 linux 容器里是 `backend=inotify`；文件级 watcher 两边都是 `backend=node`。
  ⇒ **换平台跑同一套脚本，日志里这一处会变，行为不变**（别把它误读成版本差异）。

---

## 8. 关联文档

| 文档 | 关系 |
|---|---|
| `docs/agent-platform/opencode-v2-自研机制与v2原生能力对照.md` | §2.3 **U-a** 指向本目录；§3.4 R4 / §5.1 🥇 的"✅ 已确证"由本目录支撑 |
| `docs/agent-platform/opencode-v2-contract-baseline/` | **仍是 2.0.28 的产出**（不是锁版 2.0.32）——不在本目录的交付范围内 |
| `.omo/plans/opencode-v2-adaptation.md` | §10 的 **U11**（`location/reload` 在 2.0.32 的行为）与 **U12**（逐项实测并入库）由本目录回答 |
| `.omo/plans/opencode-v2-progress.md` | 证据入库的进度记录 |
| `worker/src/reload/config-reloader.ts` · `worker/src/reload/pending-requests.ts` | 被本目录支撑的实现 |
