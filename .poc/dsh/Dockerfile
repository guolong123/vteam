FROM node:24-bookworm-slim
# DSH 运行时依赖：bubblewrap（linux 沙箱链 bwrap→Landlock）、ca-certificates、git
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates git curl jq procps \
    && rm -rf /var/lib/apt/lists/*
# DSH CLI（npm 公开发行包）。版本随 master 的 0.2.2-alpha.2。
ARG DSH_SPEC=@deepseek-ai/dsh@0.2.2-alpha.2
RUN npm i -g "${DSH_SPEC}" && dsh --version && which dsh
WORKDIR /app
COPY poc-run.cjs dbg.cjs mock-provider.cjs mock-mcp.cjs poc-patch.yml insert-test.yml /app/
