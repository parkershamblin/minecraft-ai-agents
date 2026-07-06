"""Fail-fast, typed configuration (12-factor): process env > defaults."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # --- Postgres (agent_db; memory_db moved out with the Sprint 2 extraction) ---
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    agent_db_user: str = "agent_service"
    agent_db_password: str = "agent_service_dev"
    agent_db_name: str = "agent_db"

    memory_service_url: str = "http://localhost:8002"

    # --- Kafka / Redis -------------------------------------------------------
    kafka_brokers: str = "localhost:9092"
    redis_url: str = "redis://localhost:6379"

    # --- The tick — the single number that drives cost and latency ----------
    tick_interval_seconds: int = 60
    villager_count: int = 1  # walking skeleton: ONE villager; CIV-10 sets 3
    percepts_max_per_tick: int = 10
    memories_per_tick: int = 6

    port: int = 8001

    # --- LLM (chain: openai -> ollama -> fake, probed at boot) --------------
    # 'auto' walks the chain; an explicit value pins a provider (tests: fake).
    openai_api_key: str = ""
    llm_provider: str = "auto"
    llm_model_openai: str = "gpt-4o-mini"
    ollama_base_url: str = "http://localhost:11434"
    llm_model_ollama: str = "llama3.1:8b"
    llm_temperature: float = 0.7
    # Hard daily ceiling — hitting it flips deliberation to the fake provider
    # (circuit breaker) so a forgotten overnight run cannot burn the wallet.
    llm_daily_token_budget: int = 2_000_000

    log_level: str = "info"

    @property
    def memory_db_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.memory_db_user}:{self.memory_db_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.memory_db_name}"
        )

    @property
    def agent_db_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.agent_db_user}:{self.agent_db_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.agent_db_name}"
        )
