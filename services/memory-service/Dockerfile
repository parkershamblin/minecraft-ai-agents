FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.5.13
WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
RUN uv sync --frozen --no-dev

EXPOSE 8002
CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn memory_service.main:app --host 0.0.0.0 --port 8002 --log-level warning"]
