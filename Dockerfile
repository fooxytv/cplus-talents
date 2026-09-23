# The app has no npm dependencies — http and sqlite both come from Node itself,
# so there is no install step and nothing to audit.
FROM node:24-alpine

WORKDIR /app

# .dockerignore excludes .git on purpose, so the image cannot work out its own
# commit. It is passed in instead - see deploy/README.md. Left unset the page
# says "dev", which is honest rather than wrong.
ARG GIT_SHA=""
ARG GIT_DATE=""
ARG GIT_DIRTY="0"
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA
ENV GIT_DATE=$GIT_DATE
ENV GIT_DIRTY=$GIT_DIRTY
ENV BUILD_TIME=$BUILD_TIME

# index.html is built from src/ during the image build, so the image can never
# drift from the talent data it ships with.
COPY build.js server.js ./
COPY src ./src
COPY docs ./docs
RUN node build.js

# The sqlite file lives on a volume; create it here so a named volume inherits
# the right ownership and the container can run unprivileged.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=8080 \
    HOST=0.0.0.0 \
    DB_PATH=/data/talents.db \
    NODE_ENV=production

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
