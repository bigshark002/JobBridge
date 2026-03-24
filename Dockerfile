# JobBridge / JobSpy — web UI + scraping library
FROM python:3.12-slim-bookworm

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    PORT=5000

# curl for HEALTHCHECK; add build-essential if pip wheels fail on your platform
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "poetry==1.8.5"

COPY pyproject.toml poetry.lock README.md ./
COPY jobspy ./jobspy
COPY web ./web

RUN poetry config virtualenvs.create false \
    && poetry install --no-interaction --no-ansi --only main \
    && pip install --no-cache-dir "gunicorn>=22,<24"

EXPOSE 5000

# Long timeout: searches can run several minutes across boards
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD sh -c 'curl -sf "http://127.0.0.1:$${PORT}/" > /dev/null || exit 1'

CMD ["sh", "-c", "exec gunicorn --bind \"0.0.0.0:${PORT}\" --workers 1 --threads 4 --timeout 900 --access-logfile - --error-logfile - web.app:app"]
