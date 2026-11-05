FROM node:24-bookworm-slim

ARG CODEX_VERSION=latest
ARG PLAYWRIGHT_VERSION=1.64.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash \
       ca-certificates \
       curl \
       fonts-noto-cjk \
       git \
       jq \
       less \
       openssh-client \
       python-is-python3 \
       python3-pip \
       python3-venv \
       ripgrep \
       tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
ENV NODE_PATH=/usr/local/lib/node_modules

RUN npm install --global "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps --only-shell chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/office-venv \
    && /opt/office-venv/bin/pip install --no-cache-dir \
       python-docx==1.2.0 openpyxl==3.1.5 python-pptx==1.0.2 \
    && printf '#!/bin/sh\nexec /opt/office-venv/bin/python "$@"\n' > /usr/local/bin/python \
    && chmod 755 /usr/local/bin/python \
    && cp /usr/local/bin/python /usr/local/bin/python3
ENV PATH=/opt/office-venv/bin:$PATH

RUN mkdir -p /workspace /home/node/.codex /home/node/.agents/skills \
    && chown -R node:node /workspace /home/node/.codex /home/node/.agents

ENV CODEX_HOME=/home/node/.codex
ENV HOME=/home/node

USER node
WORKDIR /workspace

ENTRYPOINT ["tini", "--", "codex"]
