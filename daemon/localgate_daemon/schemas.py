"""Pydantic request/response models and the Route/RouteReason literals."""

from typing import Literal

from pydantic import BaseModel, Field

Route = Literal["local", "cloud"]

# Shared prompt-size ceiling: the classifier routes anything longer to cloud, and /generate
# rejects it outright so Ollama never silently truncates from the front.
MAX_PROMPT_CHARS = 4000

RouteReason = Literal[
    "centroid_simple",
    "centroid_complex",
    "ambiguous_fallback",
    "rule_tool_use",
    "rule_web_required",
    "rule_realtime_required",
    "rule_multimodal",
    "rule_file_required",
    "rule_long_context",
    "rule_high_stakes",
    "rule_complex_research",
    "error_fallback",
]

# The human's verdict in HITL mode: kept local, deliberately sent to cloud, or
# left unanswered (which fails to cloud).
HitlDecision = Literal["approved_local", "overrode_cloud", "timeout_cloud"]


class HealthResponse(BaseModel):
    status: str
    classifier_loaded: bool
    ollama_reachable: bool
    model: str


# Bounded request context for logging; extra keys are ignored. A typed submodel keeps
# arbitrary caller strings out of the logs — the never-log-prompt-text rule applies here too.
class ClassifyMetadata(BaseModel):
    provider: str = Field(default="", max_length=64)
    mode: str = Field(default="", max_length=32)


class ClassifyRequest(BaseModel):
    prompt: str = Field(min_length=1)
    metadata: ClassifyMetadata = ClassifyMetadata()
    # Caller-minted correlation id joining classify/generate/feedback rows in telemetry.
    request_id: str = Field(default="", max_length=64)


class ClassifyResponse(BaseModel):
    route: Route
    confidence: float
    reason: RouteReason
    latency_ms: float


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_CHARS)
    stream: bool = False
    # None means use the daemon default (Settings.ollama_think).
    think: bool | None = None
    request_id: str = Field(default="", max_length=64)


class GenerateResponse(BaseModel):
    response: str
    model: str
    latency_ms: float
    local_energy_kwh: float | None = None
    cloud_energy_kwh: float | None = None
    local_gwp_kg: float | None = None
    cloud_gwp_kg: float | None = None
    # Generated tokens — what the cloud energy estimate is scaled on.
    tokens_estimated: int | None = None
    # Input tokens the model actually prefilled. Recorded to detect silent truncation,
    # not used for the energy estimate.
    prompt_tokens: int | None = None


class FeedbackRequest(BaseModel):
    # No prompt text by design — this records the routing verdict, not content.
    decision: HitlDecision
    provider: str = Field(default="", max_length=64)
    reason: RouteReason | None = None
    # Bounded to the classifier's [0, 1] confidence so a malformed POST can't
    # poison the telemetry.
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    request_id: str = Field(default="", max_length=64)


class StreamChunk(BaseModel):
    token: str
    done: bool = False
    model: str | None = None
    latency_ms: float | None = None
    tokens_estimated: int | None = None
    prompt_tokens: int | None = None
    local_energy_kwh: float | None = None
    cloud_energy_kwh: float | None = None
    local_gwp_kg: float | None = None
    cloud_gwp_kg: float | None = None


class StatsResponse(BaseModel):
    classifications: int
    generations: int
    local_routes: int
    cloud_routes: int
    average_latency_ms: float | None
    local_energy_kwh: float | None
    cloud_energy_kwh: float | None
    local_gwp_kg: float | None
    cloud_gwp_kg: float | None
    # HITL human-decision summary. override_rate is deliberate cloud overrides
    # over all gated decisions; None until any HITL decision is recorded.
    hitl_decisions: int = 0
    override_rate: float | None = None
