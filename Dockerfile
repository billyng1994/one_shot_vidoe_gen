# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN npm install --global pnpm@11.19.0

WORKDIR /app

FROM debian:bookworm-slim AS higgsfield-cli

ARG HIGGSFIELD_CLI_VERSION=1.1.24
ARG TARGETARCH

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && case "$TARGETARCH" in \
    amd64) HIGGSFIELD_SHA256="626ce7fbfec2df737ec1e5a8643431479fa0d2d2376d6a52b7d7467051754862" ;; \
    arm64) HIGGSFIELD_SHA256="7f54234362688b460122a6ae7d42152b16d62781f8366bf8f8d078ab566a5604" ;; \
    *) echo "Unsupported Docker architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl --fail --location --silent --show-error \
    --output /tmp/higgsfield.tar.gz \
    "https://github.com/higgsfield-ai/cli/releases/download/v${HIGGSFIELD_CLI_VERSION}/hf_${HIGGSFIELD_CLI_VERSION}_linux_${TARGETARCH}.tar.gz" \
  && echo "${HIGGSFIELD_SHA256}  /tmp/higgsfield.tar.gz" | sha256sum --check --strict \
  && tar --extract --gzip --file /tmp/higgsfield.tar.gz --directory /tmp \
  && install --mode 0755 /tmp/hf /usr/local/bin/higgsfield

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS checks

COPY . .
RUN pnpm lint && pnpm typecheck && pnpm test

FROM base AS builder

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

RUN pnpm build

FROM node:22-bookworm-slim AS runner

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates \
    dumb-init \
    ffmpeg \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe
ENV HIGGSFIELD_CLI_PATH=/usr/local/bin/higgsfield
ENV HIGGSFIELD_CREDENTIALS_PATH=/home/nextjs/.higgsfield/credentials.json
ENV HIGGSFIELD_CONFIG_PATH=/home/nextjs/.higgsfield/config.json
ENV HIGGSFIELD_NO_UPDATE_CHECK=1

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --create-home nextjs \
  && mkdir --parents /home/nextjs/.higgsfield \
  && chown --recursive nextjs:nodejs /home/nextjs/.higgsfield

COPY --from=higgsfield-cli /usr/local/bin/higgsfield /usr/local/bin/higgsfield
RUN higgsfield version

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health?check=liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
