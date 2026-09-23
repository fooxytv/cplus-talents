# No npm dependencies - http and sqlite both come from Node itself.
FROM node:24-alpine

WORKDIR /app

# same as the calculator's: the image cannot see .git, so its commit is passed in
ARG GIT_SHA=""
ARG GIT_DATE=""
ARG GIT_DIRTY="0"
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA
ENV GIT_DATE=$GIT_DATE
ENV GIT_DIRTY=$GIT_DIRTY
ENV BUILD_TIME=$BUILD_TIME

# The sim reads the talent trees straight out of src/editions, so the image
# carries the same data the calculator was built from.
COPY sim ./sim
COPY src/editions ./src/editions
COPY src/version.js ./src/version.js
# version.js reads this; without it every build would report 0.0.0
COPY VERSION ./VERSION
# the edition logo shown in the corner of the page
COPY src/logos ./src/logos

RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=8080 \
    SIM_DB=/data/sim.db \
    BASE_PATH=/sim \
    NODE_ENV=production

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+(process.env.BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "sim/server.js"]
