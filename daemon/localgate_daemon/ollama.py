"""HTTP client for the local Ollama server: health check, batch and streaming generation."""

import json as _json
import logging
from collections.abc import AsyncGenerator
from time import perf_counter

import httpx

from .schemas import GenerateResponse

logger = logging.getLogger(__name__)


class OllamaError(RuntimeError):
    pass


# Ollama trims an over-long prompt from the front with no error or flag; a
# prompt_eval_count at the ceiling is the one signal the model never saw the whole prompt.
def _warn_if_truncated(prompt_tokens: int | None, num_ctx: int) -> None:
    if prompt_tokens is not None and prompt_tokens >= num_ctx:
        logger.warning(
            "prompt filled the context window (prompt_eval_count=%s, num_ctx=%s); "
            "Ollama truncates from the start, so the response may be based on a "
            "partial prompt",
            prompt_tokens,
            num_ctx,
        )


# One timeout shape for both generation paths: timeout_s bounds the generation itself,
# connect stays short so an unreachable server fails fast.
def _timeout(timeout_s: float) -> httpx.Timeout:
    return httpx.Timeout(timeout_s, connect=10.0)


async def generate_stream(
    prompt: str,
    base_url: str,
    model: str,
    num_ctx: int,
    think: bool = False,
    timeout_s: float = 120.0,
) -> AsyncGenerator[tuple[str, bool, dict], None]:
    """Yields (token, is_done, metadata) tuples from Ollama's streaming API."""
    url = f"{base_url.rstrip('/')}/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True,
        "think": think,
        "options": {"num_ctx": num_ctx},
    }

    try:
        async with httpx.AsyncClient(timeout=_timeout(timeout_s)) as client:
            async with client.stream("POST", url, json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    chunk = _json.loads(line)
                    token = chunk.get("response", "")
                    done = chunk.get("done", False)
                    meta = {}
                    if done:
                        prompt_tokens = chunk.get("prompt_eval_count")
                        _warn_if_truncated(prompt_tokens, num_ctx)
                        meta = {
                            "eval_count": chunk.get("eval_count"),
                            "prompt_eval_count": prompt_tokens,
                        }
                    yield token, done, meta
    except httpx.HTTPError as exc:
        raise OllamaError(f"Ollama streaming failed: {exc}") from exc


async def check_ollama(base_url: str) -> bool:
    """Probe /api/tags to report whether the Ollama server is reachable."""
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"{base_url.rstrip('/')}/api/tags")
        return response.status_code == 200
    except (httpx.HTTPError, httpx.InvalidURL):
        # InvalidURL is not an HTTPError subclass; a malformed base URL must report
        # unreachable, not crash /health.
        return False


# `think` toggles chain-of-thought; either way we read the final answer (`response`),
# never the separate reasoning trace.
async def generate(
    prompt: str,
    base_url: str,
    model: str,
    num_ctx: int,
    think: bool = False,
    timeout_s: float = 120.0,
) -> GenerateResponse:
    start = perf_counter()

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "think": think,
        "options": {"num_ctx": num_ctx},
    }

    try:
        async with httpx.AsyncClient(timeout=_timeout(timeout_s)) as client:
            response = await client.post(f"{base_url.rstrip('/')}/api/generate", json=payload)

            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise OllamaError(f"Ollama request failed: {exc}") from exc

    data = response.json()
    text = data.get("response")

    if not isinstance(text, str):
        raise OllamaError("Ollama response did not include text")

    latency_ms = (perf_counter() - start) * 1000

    # Generated tokens — the figure the cloud energy estimate is scaled on.
    tokens = data.get("eval_count")
    # Input tokens actually prefilled; kept for truncation detection, not the energy estimate.
    prompt_tokens = data.get("prompt_eval_count")
    _warn_if_truncated(prompt_tokens if isinstance(prompt_tokens, int) else None, num_ctx)

    return GenerateResponse(
        response=text,
        model=model,
        latency_ms=round(latency_ms, 3),
        local_energy_kwh=None,
        tokens_estimated=tokens if isinstance(tokens, int) else None,
        prompt_tokens=prompt_tokens if isinstance(prompt_tokens, int) else None,
    )
