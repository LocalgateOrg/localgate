from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from localgate_daemon.app import create_app
from localgate_daemon.config import Settings


# Points the ollama client at a MockTransport so the daemon's real error handling runs
# instead of being stubbed out at the app boundary.
def _mock_ollama_transport(monkeypatch, handler) -> None:
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        "localgate_daemon.ollama.httpx.AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )


def test_health(monkeypatch, tmp_path: Path) -> None:
    async def fake_check_ollama(_base_url: str) -> bool:
        return True

    monkeypatch.setattr("localgate_daemon.app.check_ollama", fake_check_ollama)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["ollama_reachable"] is True


def test_classify_rule_records_stats(tmp_path: Path) -> None:
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.post(
            "/classify",
            json={"prompt": "Search the web for current stock prices.", "metadata": {}},
        )
        stats = client.get("/stats")

    assert response.status_code == 200
    assert response.json()["route"] == "cloud"
    assert stats.json()["classifications"] == 1
    assert stats.json()["cloud_routes"] == 1


def test_generate_stream_returns_sse(monkeypatch, tmp_path: Path) -> None:
    async def fake_stream(prompt, base_url, model, num_ctx, think, timeout_s):
        yield "Hello", False, {}
        yield " world", False, {}
        yield "", True, {"eval_count": 5}

    monkeypatch.setattr("localgate_daemon.app.generate_stream", fake_stream)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.post("/generate", json={"prompt": "hello", "stream": True})

    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]

    lines = [ln for ln in response.text.strip().split("\n") if ln.startswith("data: ")]
    assert len(lines) >= 3

    import json

    first = json.loads(lines[0].removeprefix("data: "))
    assert first["token"] == "Hello"
    assert first["done"] is False

    done_line = json.loads(lines[2].removeprefix("data: "))
    assert done_line["done"] is True
    assert done_line["tokens_estimated"] == 5

    assert lines[-1] == "data: [DONE]"


def test_generate_uses_ollama_boundary(monkeypatch, tmp_path: Path) -> None:
    async def fake_generate(prompt, base_url, model, num_ctx, think, timeout_s):
        from localgate_daemon.schemas import GenerateResponse

        assert prompt == "Explain recursion."
        assert base_url == "http://localhost:11434"
        return GenerateResponse(response="local answer", model=model, latency_ms=1.0)

    monkeypatch.setattr("localgate_daemon.app.generate", fake_generate)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.post("/generate", json={"prompt": "Explain recursion.", "stream": False})

    assert response.status_code == 200
    assert response.json()["response"] == "local answer"


def test_generate_think_override_and_default(monkeypatch, tmp_path: Path) -> None:
    captured: list[bool] = []

    async def fake_generate(prompt, base_url, model, num_ctx, think, timeout_s):
        from localgate_daemon.schemas import GenerateResponse

        captured.append(think)
        return GenerateResponse(response="ok", model=model, latency_ms=1.0)

    monkeypatch.setattr("localgate_daemon.app.generate", fake_generate)
    # Daemon default is think=False; a request can override it to True.
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        client.post("/generate", json={"prompt": "x", "stream": False, "think": True})
        client.post("/generate", json={"prompt": "x", "stream": False})  # omitted -> default

    assert captured == [True, False]


def test_classify_log_excludes_prompt_text(caplog, tmp_path: Path) -> None:
    caplog.set_level("INFO", logger="localgate_daemon.app")
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))
    prompt = "Search the web for a private phrase that should not be logged."

    with TestClient(app) as client:
        response = client.post(
            "/classify",
            json={
                "prompt": prompt,
                "metadata": {"provider": "chatgpt", "mode": "transparent"},
            },
        )

    assert response.status_code == 200
    assert "rule_web_required" in caplog.text
    assert prompt not in caplog.text


def test_empty_prompt_returns_422(tmp_path: Path) -> None:
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.post(
            "/classify", json={"prompt": "", "metadata": {}}
        )

    assert response.status_code == 422


def test_generate_ollama_failure_returns_503(
    monkeypatch, tmp_path: Path
) -> None:
    async def failing_generate(prompt, base_url, model, num_ctx, think, timeout_s):
        from localgate_daemon.ollama import OllamaError

        raise OllamaError("connection refused")

    monkeypatch.setattr("localgate_daemon.app.generate", failing_generate)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.post(
            "/generate",
            json={"prompt": "hello", "stream": False},
        )

    assert response.status_code == 503


@pytest.mark.parametrize("status_code", [500, 404])
def test_generate_returns_503_when_ollama_answers_with_an_error_status(
    monkeypatch, tmp_path: Path, status_code: int
) -> None:
    # A narrowed except clause in ollama.generate would let HTTPStatusError escape, and
    # FastAPI would answer 500 with the exception text — which carries the base URL.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json={"error": "model 'gemma4:e2b' not found"})

    _mock_ollama_transport(monkeypatch, handler)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/generate", json={"prompt": "hello", "stream": False})

    assert response.status_code == 503


def test_generate_returns_503_when_ollama_refuses_the_connection(
    monkeypatch, tmp_path: Path
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _mock_ollama_transport(monkeypatch, handler)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/generate", json={"prompt": "hello", "stream": False})

    assert response.status_code == 503


def test_stream_reports_an_ollama_error_status_as_a_503(monkeypatch, tmp_path: Path) -> None:
    # The first chunk is pulled before the response is committed, so a failure that
    # happens at stream start is still a status code rather than a half-written 200.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "out of memory"})

    _mock_ollama_transport(monkeypatch, handler)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/generate", json={"prompt": "hello", "stream": True})

    assert response.status_code == 503
    # A narrower `except` in ollama.py would let the HTTPStatusError escape as a 500
    # carrying the exception text, which leaks the base URL.
    assert "localhost:11434" not in response.text


def test_generate_persists_local_and_cloud_energy_under_their_own_names(
    monkeypatch, tmp_path: Path
) -> None:
    # Four distinct, non-round values so a transposed field or column is visible in
    # the round trip: the local draw is measured, the cloud figure is an estimate.
    from localgate_daemon.energy import EnergyResult
    from localgate_daemon.schemas import GenerateResponse

    @contextmanager
    def fake_measure_local(enabled: bool, grid_zone: str):
        assert enabled is True
        yield EnergyResult(energy_kwh=0.000412, gwp_kg=0.000173)

    def fake_estimate_cloud(provider: str, model: str, output_tokens: int, grid_zone: str):
        assert output_tokens == 128  # the cloud estimate is scaled by the local token count
        return EnergyResult(energy_kwh=0.008317, gwp_kg=0.003941)

    async def fake_generate(prompt, base_url, model, num_ctx, think, timeout_s):
        return GenerateResponse(
            response="local answer", model=model, latency_ms=1.0, tokens_estimated=128
        )

    monkeypatch.setattr("localgate_daemon.app.measure_local", fake_measure_local)
    monkeypatch.setattr("localgate_daemon.app.estimate_cloud", fake_estimate_cloud)
    monkeypatch.setattr("localgate_daemon.app.generate", fake_generate)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite", enable_energy=True))

    with TestClient(app) as client:
        body = client.post("/generate", json={"prompt": "hello", "stream": False}).json()
        summary = client.get("/stats").json()

    assert body["local_energy_kwh"] == 0.000412
    assert body["cloud_energy_kwh"] == 0.008317
    assert body["local_gwp_kg"] == 0.000173
    assert body["cloud_gwp_kg"] == 0.003941
    assert summary["local_energy_kwh"] == 0.000412
    assert summary["cloud_energy_kwh"] == 0.008317
    assert summary["local_gwp_kg"] == 0.000173
    assert summary["cloud_gwp_kg"] == 0.003941


def test_generate_omits_the_cloud_estimate_when_energy_is_disabled(
    monkeypatch, tmp_path: Path
) -> None:
    from localgate_daemon.schemas import GenerateResponse

    def unreachable_estimate_cloud(*args, **kwargs):
        raise AssertionError("cloud estimate must not run with energy disabled")

    async def fake_generate(prompt, base_url, model, num_ctx, think, timeout_s):
        return GenerateResponse(
            response="local answer", model=model, latency_ms=1.0, tokens_estimated=128
        )

    monkeypatch.setattr("localgate_daemon.app.estimate_cloud", unreachable_estimate_cloud)
    monkeypatch.setattr("localgate_daemon.app.generate", fake_generate)
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        body = client.post("/generate", json={"prompt": "hello", "stream": False}).json()

    assert body["cloud_energy_kwh"] is None
    assert body["local_energy_kwh"] is None


def test_stats_on_empty_database(tmp_path: Path) -> None:
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.get("/stats")

    assert response.status_code == 200
    data = response.json()
    assert data["classifications"] == 0
    assert data["generations"] == 0
    assert data["average_latency_ms"] is None
    assert data["hitl_decisions"] == 0
    assert data["override_rate"] is None


def test_feedback_records_decision_and_omits_prompt(caplog, tmp_path: Path) -> None:
    caplog.set_level("INFO", logger="localgate_daemon.app")
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.post(
            "/feedback",
            json={
                "decision": "overrode_cloud",
                "provider": "chatgpt",
                "reason": "centroid_simple",
                "confidence": 0.61,
            },
        )
        stats = client.get("/stats")

    assert response.status_code == 204
    assert stats.json()["hitl_decisions"] == 1
    # The schema has no prompt field; the log records the verdict, not content.
    assert "overrode_cloud" in caplog.text


def test_feedback_override_rate(tmp_path: Path) -> None:
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        for decision in (
            "approved_local",
            "overrode_cloud",
            "overrode_cloud",
            "timeout_cloud",
        ):
            client.post("/feedback", json={"decision": decision, "provider": "chatgpt"})
        stats = client.get("/stats")

    data = stats.json()
    # 2 deliberate overrides out of 4 gated decisions; timeout is not an override.
    assert data["hitl_decisions"] == 4
    assert data["override_rate"] == 0.5


def test_feedback_rejects_unknown_decision(tmp_path: Path) -> None:
    app = create_app(Settings(db_path=tmp_path / "test.sqlite"))

    with TestClient(app) as client:
        response = client.post("/feedback", json={"decision": "maybe"})

    assert response.status_code == 422
