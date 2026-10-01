"""Daemon settings, read from the environment with the LOCALGATE_ prefix."""

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LOCALGATE_", env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8400
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "gemma4:e2b"
    # Chain-of-thought off by default: the local route exists for speed and simple prompts
    # rarely need it. Overridable per request; only the final answer is ever returned.
    ollama_think: bool = False
    # Pinned rather than inherited: Ollama's own default varies with available VRAM, and it
    # silently trims over-long prompts from the front. 8192 is generous — the classifier
    # already sends anything over 4000 characters to the cloud.
    ollama_num_ctx: int = 8192
    # Read/write budget for a single Ollama generation, in seconds. Connect stays short
    # independently of this so an unreachable server fails fast.
    ollama_timeout_s: float = 120.0

    embedding_model: str = "BAAI/bge-small-en-v1.5"
    # Bounded to [0, 1]: a negative threshold would invert the ambiguous-goes-to-cloud rule.
    classifier_threshold: float = Field(default=0.05, ge=0.0, le=1.0)

    # Home-anchored so the database does not split by working directory.
    db_path: Path = Path.home() / ".localgate/localgate.sqlite"
    enable_energy: bool = False

    # Cloud model the avoided-cloud estimate is computed against (must be EcoLogits-supported).
    # Standard tier, pinned snapshot for reproducibility.
    cloud_reference_provider: str = "openai"
    cloud_reference_model: str = "gpt-5.4-2026-03-05"
    # ISO-3166 alpha-3 grid zone ("WOR" = world average). Drives both CodeCarbon and
    # EcoLogits so the two carbon numbers share one grid; energy is unaffected.
    energy_grid_zone: str = "WOR"

    log_level: str = "INFO"
