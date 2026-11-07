ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG CODEX_VERSION=latest
ARG LIBREOFFICE_VERSION=4:7.4.7-1+deb12u14
ARG PLAYWRIGHT_VERSION=1.65.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash \
       ca-certificates \
       curl \
       file \
       fonts-noto-cjk \
       git \
       jq \
       less \
       libreoffice-calc-nogui=${LIBREOFFICE_VERSION} \
       libreoffice-impress-nogui=${LIBREOFFICE_VERSION} \
       libreoffice-writer-nogui=${LIBREOFFICE_VERSION} \
       openssh-client \
       poppler-utils \
       python-is-python3 \
       python3-pip \
       python3-venv \
       ripgrep \
       tini \
       unzip \
       wget \
       zip \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
ENV NODE_PATH=/usr/local/lib/node_modules

RUN npm install --global "playwright@${PLAYWRIGHT_VERSION}" \
    && playwright install --with-deps --only-shell chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt

RUN python3 -m venv /opt/office-venv \
    && /opt/office-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && printf '#!/bin/sh\nexec /opt/office-venv/bin/python "$@"\n' > /usr/local/bin/python \
    && chmod 755 /usr/local/bin/python \
    && cp /usr/local/bin/python /usr/local/bin/python3 \
    && printf '#!/bin/sh\nexec /opt/office-venv/bin/python -m pip "$@"\n' > /usr/local/bin/pip \
    && chmod 755 /usr/local/bin/pip \
    && cp /usr/local/bin/pip /usr/local/bin/pip3
ENV PATH=/opt/office-venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       diffutils dnsutils findutils iproute2 iputils-ping netcat-openbsd patch tree \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspace /home/node/.codex /home/node/.agents/skills \
    && chown -R node:node /workspace /home/node/.codex /home/node/.agents

ENV CODEX_HOME=/home/node/.codex
ENV HOME=/home/node

COPY app-server/package*.json /opt/codex-mqtt/
RUN cd /opt/codex-mqtt && npm ci --omit=dev && npm cache clean --force
COPY app-server/*.mjs /opt/codex-mqtt/

USER node
WORKDIR /workspace

ENTRYPOINT ["tini", "--", "codex"]
