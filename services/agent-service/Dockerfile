# Build context = repo root (the decision contract validates against
# packages/events/schemas at runtime, so the schemas ship in the image).
FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.5.13
WORKDIR /repo/services/agent-service

# Dependency layer first.
COPY services/agent-service/pyproject.toml services/agent-service/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# The contract package and the service.
COPY packages/events/schemas/ /repo/packages/events/schemas/
COPY services/agent-service/ ./
RUN uv sync --frozen --no-dev

EXPOSE 8001
# agent_db migrations, then the app. Idempotent by design.
CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn agent_service.main:app --host 0.0.0.0 --port 8001 --log-level warning"]
