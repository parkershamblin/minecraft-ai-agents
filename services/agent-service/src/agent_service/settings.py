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
    # The ledger read seam (RB-2 rehydration): where a booting brain asks
    # "is an attempt live right now?". Blank disables rehydration (tests).
    event_service_url: str = "http://localhost:8081"

    # --- Kafka / Redis -------------------------------------------------------
    kafka_brokers: str = "localhost:9092"
    redis_url: str = "redis://localhost:6379"

    # --- Filming levers (D2, staged in M2-10) --------------------------------
    # One system-prompt line naming a village-wide aim. OFF by default —
    # steering is a lever the operator pulls only if the arc stalls.
    community_goal: str = ""

    # --- The tick — the single number that drives cost and latency ----------
    tick_interval_seconds: int = 60
    villager_count: int = 1  # walking skeleton: ONE villager; CIV-10 sets 3
    percepts_max_per_tick: int = 10
    reactive_cooldown_seconds: float = 15.0
    max_reactive_per_5min: int = 3
    reactive_imminent_seconds: float = 10.0
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
    # Max in-flight completions against the one shared backend — extra ticks
    # queue at the provider (a single Ollama GPU thrashes under 20 parallel
    # calls; serial-ish requests finish sooner in aggregate).
    llm_max_concurrent_requests: int = 4
    # Hard daily ceiling — hitting it flips deliberation to the fake provider
    # (circuit breaker) so a forgotten overnight run cannot burn the wallet.
    llm_daily_token_budget: int = 2_000_000
    # --- Per-team brains (RB filming: rival teams on different local models) --
    # "red=llama3.1:8b,blue=gemma3:12b" routes each race team's deliberation to
    # its own warmed Ollama model (villagers outside a team, or pre-race, stay
    # on the chain above). Blank = off. Strict at boot: malformed spec or a
    # model missing from `ollama list` refuses to start — a silently degraded
    # team brain would poison a filmed race.
    llm_team_models: str = ""
    # KV-cache ceiling per request. The Windows host default drifted to a
    # 65536-token context (13 GB VRAM for an 8B model); prompts run 3-5k
    # tokens, so 8192 keeps two team models resident together on one 24 GB GPU.
    ollama_num_ctx: int = 8192

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
