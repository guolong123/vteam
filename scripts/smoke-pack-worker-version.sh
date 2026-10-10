#!/bin/sh
#
# smoke-pack-worker-version.sh —— pack-worker.sh 版本戳链路冒烟。
#
# 断言（全部通过才 exit 0）：
#   1. dist/version.js 生成且含 WORKER_CODE_VERSION = <版本>
#   2. tar -tzf 发布包含 dist/version.js（且 tar 清单成员未变）
#   3. web/public/worker-src.version.json 存在，version/sha256/builtAt 三字段齐全
#   4. version.json 的 sha256 与实际 tarball 字节摘要一致（自更新校验的依据）
#   5. version.json 的 version 与 dist/version.js 中的版本一致
#   6. 非 git 目录执行 pack-worker.sh --print-version 回退 manual-<YYYYMMDD>
#
# 会真实跑一次 npm run build + 打包（数十秒）。产物走 .gitignore，不入库。
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAILED=0
ok() { echo "  [OK]   $1"; }
fail() { echo "  [FAIL] $1"; FAILED=1; }

TARBALL="web/public/worker-src.tar.gz"
META="web/public/worker-src.version.json"
VERSION_FILE="worker/dist/version.js"

echo "== 1/3 运行 pack-worker.sh =="
sh scripts/pack-worker.sh

echo "== 断言 dist/version.js =="
if [ -f "$VERSION_FILE" ]; then
  STAMPED_VERSION="$(sed -n "s/.*WORKER_CODE_VERSION = '\([^']*\)';.*/\1/p" "$VERSION_FILE")"
  if [ -n "$STAMPED_VERSION" ]; then
    ok "dist/version.js 版本 = ${STAMPED_VERSION}"
  else
    fail "dist/version.js 存在但解析不出 WORKER_CODE_VERSION"
  fi
else
  STAMPED_VERSION=""
  fail "dist/version.js 未生成"
fi

echo "== 断言 tar 清单 =="
TAR_MEMBERS="$(tar -tzf "$TARBALL" | sed 's|^\./||' | cut -d/ -f1 | sort -u | tr '\n' ' ')"
if tar -tzf "$TARBALL" | grep -qx 'dist/version.js'; then
  ok "tar 含版本戳文件 dist/version.js"
else
  fail "tar 缺 dist/version.js"
fi
# dist/version.js 同时是 tsc 产物路径（src/version.ts），故运行时解析模块刻意改名
# code-version.ts 避免被版本戳文件覆盖；这里断言解析模块确实随包发布。
if tar -tzf "$TARBALL" | grep -qx 'dist/code-version.js'; then
  ok "tar 含运行时解析模块 dist/code-version.js（未被版本戳覆盖）"
else
  fail "tar 缺 dist/code-version.js（版本戳文件覆盖了 tsc 产物？）"
fi
EXPECTED_MEMBERS=".env.example dist package-lock.json package.json scripts "
if [ "$TAR_MEMBERS" = "$EXPECTED_MEMBERS" ]; then
  ok "tar 顶层清单未变：${TAR_MEMBERS}"
else
  fail "tar 顶层清单变化：期望 [${EXPECTED_MEMBERS}] 实际 [${TAR_MEMBERS}]"
fi

echo "== 断言 version.json =="
if [ -f "$META" ]; then
  ok "version.json 存在"
  META_VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$META")"
  META_SHA="$(sed -n 's/.*"sha256": "\([^"]*\)".*/\1/p' "$META")"
  META_BUILT_AT="$(sed -n 's/.*"builtAt": "\([^"]*\)".*/\1/p' "$META")"

  [ -n "$META_VERSION" ] && ok "字段 version = ${META_VERSION}" || fail "字段 version 缺失"
  [ -n "$META_SHA" ] && ok "字段 sha256 = ${META_SHA}" || fail "字段 sha256 缺失"
  if printf '%s' "$META_BUILT_AT" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    ok "字段 builtAt = ${META_BUILT_AT}（ISO 8601 UTC）"
  else
    fail "字段 builtAt 非 ISO 8601 UTC：${META_BUILT_AT}"
  fi

  if [ "$META_VERSION" = "$STAMPED_VERSION" ]; then
    ok "version.json.version 与 dist/version.js 一致"
  else
    fail "版本不一致：version.json=${META_VERSION} dist/version.js=${STAMPED_VERSION}"
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
  else
    ACTUAL_SHA="$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TARBALL")"
  fi
  if [ "$META_SHA" = "$ACTUAL_SHA" ]; then
    ok "sha256 与 tarball 实际字节一致"
  else
    fail "sha256 不匹配：meta=${META_SHA} actual=${ACTUAL_SHA}"
  fi
else
  fail "version.json 未生成：${META}"
fi

echo "== 断言非 git 回退 =="
NON_GIT_DIR="$(mktemp -d)"
(
  cd "$NON_GIT_DIR"
  FALLBACK_VERSION="$(sh "$ROOT/scripts/pack-worker.sh" --print-version)"
  if printf '%s' "$FALLBACK_VERSION" | grep -Eq '^manual-[0-9]{8}$'; then
    ok "非 git 环境回退 manual-<YYYYMMDD> = ${FALLBACK_VERSION}"
  else
    fail "非 git 环境未回退 manual-<date>，实际 ${FALLBACK_VERSION}"
  fi
)
rm -rf "$NON_GIT_DIR"

echo "== 结果 =="
if [ "$FAILED" -eq 0 ]; then
  echo "SMOKE PASS"
else
  echo "SMOKE FAIL"
fi
exit "$FAILED"