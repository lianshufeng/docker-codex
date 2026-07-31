FROM node:24-bookworm-slim

ARG CODEX_VERSION=latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash \
       ca-certificates \
       curl \
       git \
       jq \
       less \
       openssh-client \
       ripgrep \
       tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

RUN mkdir -p /workspace /home/node/.codex /home/node/.agents/skills \
    && chown -R node:node /workspace /home/node/.codex /home/node/.agents

ENV CODEX_HOME=/home/node/.codex
ENV HOME=/home/node

USER node
WORKDIR /workspace

ENTRYPOINT ["tini", "--", "codex"]
