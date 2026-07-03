"""Fail-fast, typed configuration (12-factor): process env > defaults."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # --- Postgres (database-per-service: agent_db later, memory_db now) -----
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    memory_db_user: str = "memory_service"
    memory_db_password: str = "memory_service_dev"
    memory_db_name: str = "memory_db"

    # --- LLM (chain: openai -> ollama -> fake, probed at boot) --------------
    # 'auto' walks the chain; an explicit value pins a provider (tests: fake).
    llm_provider: str = "auto"
    llm_model_openai: str = "gpt-4o-mini"
    llm_model_ollama: str = "llama3.1:8b"
    llm_temperature: float = 0.7
    # Hard daily ceiling — hitting it flips deliberation to the fake provider
    # (circuit breaker) so a forgotten overnight run cannot burn the wallet.
    llm_daily_token_budget: int = 2_000_000

    # --- Embeddings (chain: openai -> ollama -> fake, probed at boot) -------
    openai_api_key: str = ""
    embedding_model_openai: str = "text-embedding-3-small"
    ollama_base_url: str = "http://localhost:11434"
    embedding_model_ollama: str = "nomic-embed-text"
    # vector(768): nomic native; OpenAI via Matryoshka dimensions=768.
    # One model per deployment — switching means an offline re-embed backfill.
    embedding_dim: int = 768

    # --- Retrieval: recency x importance x relevance ------------------------
    retrieval_w_recency: float = 1.0
    retrieval_w_importance: float = 1.0
    retrieval_w_relevance: float = 1.0
    recency_decay_per_hour: float = 0.995
    # over-fetch factor: ANN by relevance first, re-rank with the full formula
    retrieval_candidate_factor: int = 3

    log_level: str = "info"

    @property
    def memory_db_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.memory_db_user}:{self.memory_db_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.memory_db_name}"
        )
