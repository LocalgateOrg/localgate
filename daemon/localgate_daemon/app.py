"""FastAPI app factory and HTTP routes for the LocalGate daemon."""

import asyncio
import json
import logging
import sqlite3
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from sqlite3 import Connection
from time import perf_counter

from fastapi import FastAPI, HTTPException, Request, status
from starlette.responses import StreamingResponse

from .classifier import CentroidClassifier
from .config import Settings
from .energy import estimate_cloud, measure_local
from .ollama import OllamaError, check_ollama, generate, generate_stream
from .schemas import (
    ClassifyRequest,
    ClassifyResponse,
    FeedbackRequest,
    GenerateRequest,
    GenerateResponse,
    HealthResponse,
    StatsResponse,
    StreamChunk,
)
from .storage import (
    connect,
    record_classification,
    record_feedback,
    record_generation,
    stats,
)

logger = logging.getLogger(__name__)

OLLAMA_UNAVAILABLE_DETAIL = "local model unavailable"

# CodeCarbon measures system-wide, so overlapping trackers double-bill each other.
# Serialize the measured region; unmeasured runs never touch the lock.
_energy_lock = asyncio.Lock()


@asynccontextmanager
async def _energy_guard(enabled: bool):
    if enabled:
        async with _energy_lock:
            yield
    else:
        yield


async def _batch_generate(
    db: Connection, s: Settings, prompt: str, think: bool, request_id: str
) -> GenerateResponse:
    try:
        async with _energy_guard(s.enable_energy):
            with measure_local(s.enable_energy, s.energy_grid_zone) as energy:
                result = await generate(
                    prompt=prompt,
                    base_url=s.ollama_base_url,
                    model=s.ollama_model,
                    num_ctx=s.ollama_num_ctx,
                    think=think,
                    timeout_s=s.ollama_timeout_s,
                )
    except OllamaError as exc:
        logger.warning("ollama generation failed model=%s error=%s", s.ollama_model, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=OLLAMA_UNAVAILABLE_DETAIL,
        ) from exc

    result.local_energy_kwh = energy.energy_kwh
    result.local_gwp_kg = energy.gwp_kg

    if s.enable_energy:
        cloud = estimate_cloud(
            s.cloud_reference_provider,
            s.cloud_reference_model,
            result.tokens_estimated,
            s.energy_grid_zone,
        )
        result.cloud_energy_kwh = cloud.energy_kwh
        result.cloud_gwp_kg = cloud.gwp_kg

    try:
        record_generation(db, result, request_id)
    except sqlite3.Error:
        logger.warning("telemetry write failed for generation", exc_info=True)
    logger.info(
        "generated local response model=%s latency_ms=%.3f tokens_estimated=%s "
        "prompt_tokens=%s num_ctx=%s",
        result.model, result.latency_ms, result.tokens_estimated,
        result.prompt_tokens, s.ollama_num_ctx,
    )
    return result


async def _stream_generate(
    db: Connection,
    s: Settings,
    start: float,
    first_chunk: tuple[str, bool, dict],
    rest: AsyncIterator[tuple[str, bool, dict]],
    request_id: str,
) -> AsyncGenerator[str, None]:
    tokens_estimated = None
    prompt_tokens = None

    async def chunks() -> AsyncIterator[tuple[str, bool, dict]]:
        yield first_chunk
        async for item in rest:
            yield item

    try:
        async with _energy_guard(s.enable_energy):
            with measure_local(s.enable_energy, s.energy_grid_zone) as energy:
                async for token, done, meta in chunks():
                    if done:
                        tokens_estimated = meta.get("eval_count")
                        prompt_tokens = meta.get("prompt_eval_count")
                        latency_ms = round((perf_counter() - start) * 1000, 3)
                        final = StreamChunk(
                            token=token,
                            done=True,
                            model=s.ollama_model,
                            latency_ms=latency_ms,
                            tokens_estimated=tokens_estimated,
                            prompt_tokens=prompt_tokens,
                        )
                    else:
                        final = StreamChunk(token=token)
                    yield f"data: {json.dumps(final.model_dump())}\n\n"
    except OllamaError as exc:
        # The response is already committed here, so in-band is the only error channel.
        logger.warning("ollama streaming failed model=%s error=%s", s.ollama_model, exc)
        yield f"data: {json.dumps({'error': OLLAMA_UNAVAILABLE_DETAIL})}\n\n"
        yield "data: [DONE]\n\n"
        return

    result = GenerateResponse(
        response="",
        model=s.ollama_model,
        latency_ms=round((perf_counter() - start) * 1000, 3),
        tokens_estimated=tokens_estimated,
        prompt_tokens=prompt_tokens,
        local_energy_kwh=energy.energy_kwh,
        local_gwp_kg=energy.gwp_kg,
    )
    if s.enable_energy:
        cloud = estimate_cloud(
            s.cloud_reference_provider,
            s.cloud_reference_model,
            tokens_estimated,
            s.energy_grid_zone,
        )
        result.cloud_energy_kwh = cloud.energy_kwh
        result.cloud_gwp_kg = cloud.gwp_kg

    try:
        record_generation(db, result, request_id)
    except sqlite3.Error:
        logger.warning("telemetry write failed for generation", exc_info=True)
    yield "data: [DONE]\n\n"


def create_app(
    settings: Settings | None = None, classifier: CentroidClassifier | None = None
) -> FastAPI:
    resolved_settings = settings or Settings()

    # Injectable so tests can supply a fake instead of the real embedding model.
    resolved_classifier = classifier or CentroidClassifier(
        model_name=resolved_settings.embedding_model,
        threshold=resolved_settings.classifier_threshold,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = resolved_settings
        app.state.classifier = resolved_classifier
        app.state.db = connect(resolved_settings.db_path)

        # Warm now so the first request does not pay the embedding-model download;
        # on failure the classifier's own error fallback still routes cloud.
        try:
            resolved_classifier.warm_up()
        except Exception:
            logger.warning("classifier warm-up failed; requests fall back to cloud",
                           exc_info=True)

        logger.debug(
            "daemon initialized db_path=%s embedding_model=%s",
            resolved_settings.db_path,
            resolved_settings.embedding_model,
        )
        try:
            yield
        finally:
            app.state.db.close()

    app = FastAPI(title="LocalGate daemon", version="0.1.0", lifespan=lifespan)

    @app.get("/health", response_model=HealthResponse)
    async def health(request: Request) -> HealthResponse:
        app_settings = get_settings(request)
        return HealthResponse(
            status="ok",
            classifier_loaded=get_classifier(request).loaded,
            ollama_reachable=await check_ollama(app_settings.ollama_base_url),
            model=app_settings.ollama_model,
        )

    # Sync handler: FastAPI runs it on the threadpool, keeping the (possibly slow)
    # synchronous classifier off the event loop.
    @app.post("/classify", response_model=ClassifyResponse)
    def classify(request_body: ClassifyRequest, request: Request) -> ClassifyResponse:
        result = get_classifier(request).classify(request_body.prompt)

        try:
            record_classification(get_db(request), result, request_body.request_id)
        except sqlite3.Error:
            logger.warning("telemetry write failed for classification", exc_info=True)

        logger.info(
            "classified prompt route=%s reason=%s confidence=%.3f "
            "latency_ms=%.3f provider=%s mode=%s",
            result.route,
            result.reason,
            result.confidence,
            result.latency_ms,
            request_body.metadata.provider,
            request_body.metadata.mode,
        )
        return result

    @app.post("/generate", response_model=None)
    async def generate_local(
        request_body: GenerateRequest, request: Request
    ) -> GenerateResponse | StreamingResponse:
        app_settings = get_settings(request)
        db = get_db(request)
        think = (
            request_body.think
            if request_body.think is not None
            else app_settings.ollama_think
        )

        if request_body.stream:
            start = perf_counter()
            stream = generate_stream(
                prompt=request_body.prompt,
                base_url=app_settings.ollama_base_url,
                model=app_settings.ollama_model,
                num_ctx=app_settings.ollama_num_ctx,
                think=think,
                timeout_s=app_settings.ollama_timeout_s,
            )
            # Pull the first chunk before committing the response, so an unreachable Ollama
            # surfaces as the same 503 the batch path raises instead of an in-band error
            # inside an already-committed 200.
            try:
                first_chunk = await anext(stream, None)
            except OllamaError as exc:
                logger.warning(
                    "ollama generation failed model=%s error=%s", app_settings.ollama_model, exc
                )
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=OLLAMA_UNAVAILABLE_DETAIL,
                ) from exc
            if first_chunk is None:
                logger.warning("ollama stream ended without output model=%s",
                               app_settings.ollama_model)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=OLLAMA_UNAVAILABLE_DETAIL,
                )
            return StreamingResponse(
                _stream_generate(
                    db, app_settings, start, first_chunk, stream, request_body.request_id
                ),
                media_type="text/event-stream",
            )

        return await _batch_generate(
            db, app_settings, request_body.prompt, think, request_body.request_id
        )

    # Records a HITL human decision. No prompt text crosses this boundary.
    @app.post("/feedback", status_code=status.HTTP_204_NO_CONTENT)
    async def feedback(request_body: FeedbackRequest, request: Request) -> None:
        record_feedback(get_db(request), request_body)
        logger.info(
            "hitl decision=%s provider=%s reason=%s confidence=%s",
            request_body.decision,
            request_body.provider,
            request_body.reason,
            request_body.confidence,
        )

    @app.get("/stats", response_model=StatsResponse)
    async def read_stats(request: Request) -> StatsResponse:
        return stats(get_db(request))

    return app


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_classifier(request: Request) -> CentroidClassifier:
    return request.app.state.classifier


def get_db(request: Request) -> Connection:
    return request.app.state.db


app = create_app()
