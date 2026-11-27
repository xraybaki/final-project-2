# SANCHAR - Smart AI Navigation for Convoy Hazard Avoidance & Rerouting
# Runtime image: Node (server, built-in modules only) + Python 3 standard library (SITREP parsing).
# The data pipeline does NOT run here; its outputs (routing graph, landmarks, ...) are committed.
#
# Two official images, no apt-get: the Node binary is copied from node:22-slim into
# python:3.12-slim (which already has the C++ runtime Node needs). Faster, reproducible builds
# that also work where Debian mirrors are blocked.
FROM node:22-slim AS node

FROM python:3.12-slim
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# Optional: real Gemini SITREP field extraction. Build with --build-arg WITH_GEMINI=1
ARG WITH_GEMINI=0
RUN if [ "$WITH_GEMINI" = "1" ]; then \
      pip install --no-cache-dir google-genai python-dotenv; \
    fi

ENV NODE_ENV=production \
    PYTHON=python3 \
    PYTHONUTF8=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=10000

WORKDIR /app
COPY . .
RUN node --version && python3 --version

EXPOSE 10000
CMD ["node", "server.js"]
