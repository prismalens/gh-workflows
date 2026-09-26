# The runner's job image (#184, spec Q3). Build context is runner/; build with scripts/build-image.mjs,
# which tags assayer-runner:<input hash> so the daemon runs exactly the bits this checkout describes.
FROM docker.io/library/node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

ARG ACTIONLINT_VERSION=1.7.12
ARG ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ARG SHELLCHECK_VERSION=0.11.0
ARG SHELLCHECK_SHA256=8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198
ARG GH_VERSION=2.101.0
ARG GH_SHA256=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8
ARG OPENCODE_VERSION=1.18.30
ARG CLAUDE_CODE_VERSION=2.1.283
ARG CLAUDE_AGENT_ACP_VERSION=0.81.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 socat xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/tools
RUN curl --proto '=https' --tlsv1.2 -fsSLo actionlint.tar.gz "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
 && echo "${ACTIONLINT_SHA256}  actionlint.tar.gz" | sha256sum -c - \
 && tar -xzf actionlint.tar.gz actionlint && install -m 0755 actionlint /usr/local/bin/actionlint \
 && curl --proto '=https' --tlsv1.2 -fsSLo shellcheck.tar.xz "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz" \
 && echo "${SHELLCHECK_SHA256}  shellcheck.tar.xz" | sha256sum -c - \
 && tar -xJf shellcheck.tar.xz && install -m 0755 "shellcheck-v${SHELLCHECK_VERSION}/shellcheck" /usr/local/bin/shellcheck \
 && curl --proto '=https' --tlsv1.2 -fsSLo gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  gh.tar.gz" | sha256sum -c - \
 && tar -xzf gh.tar.gz && install -m 0755 "gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && cd / && rm -rf /tmp/tools

RUN npm install -g --no-fund --no-audit \
      "opencode-ai@${OPENCODE_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}" \
 && npm cache clean --force

WORKDIR /opt/assayer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
COPY src ./src
COPY prompt ./prompt
COPY image/entrypoint.sh /usr/local/bin/assayer-entrypoint

ENV CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude LANG=C.UTF-8
WORKDIR /checkout
# No USER: the daemon passes --user so the container runs as the daemon's own uid.
ENTRYPOINT ["/usr/local/bin/assayer-entrypoint"]
