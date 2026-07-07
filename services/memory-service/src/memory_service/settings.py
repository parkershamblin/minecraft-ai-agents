"""Fail-fast, typed configuration (12-factor): process env > defaults."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    memory_db_user: str = "memory_service"
    memory_db_password: str = "memory_service_dev"
    memory_db_name: str = "memory_db"

    # --- Embeddings (chain: openai -> ollama -> fake, probed at boot) -------
    openai_api_key: str = ""
    embedding_model_openai: str = "text-embedding-3-small"
    ollama_base_url: str = "http://localhost:11434"
    embedding_model_ollama: str = "nomic-embed-text"
    # vector(768): nomic native; OpenAI via Matryoshka dimensions=768.
    embedding_dim: int = 768

    # --- Retrieval: recency x importance x relevance -------------------------
    retrieval_w_recency: float = 1.0
    retrieval_w_importance: float = 1.0
    retrieval_w_relevance: float = 1.0
    recency_decay_per_hour: float = 0.995
    retrieval_candidate_factor: int = 3

    # --- Reflections (M1-9): own LLM port, own breaker — budgets are per
    # service. No fake fallback in the chain: no real LLM means reflections OFF.
    reflection_enabled: bool = True
    llm_provider: str = "auto"
    llm_model_openai: str = "gpt-4o-mini"
    llm_model_ollama: str = "llama3.1:8b"
    llm_temperature: float = 0.7
    reflection_daily_token_budget: int = 200_000
    reflections_per_hour_cap: int = 12  # global, not per villager — bounds GPU load
    reflection_importance_threshold: float = 30.0
    reflection_interval_seconds: int = 300
    reflection_recent_limit: int = 20  # memories per reflection prompt

    kafka_brokers: str = "localhost:9092"

    port: int = 8002
    log_level: str = "info"

    @property
    def memory_db_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.memory_db_user}:{self.memory_db_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.memory_db_name}"
        )
