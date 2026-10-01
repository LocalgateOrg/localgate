import asyncio
import json
import logging

import httpx
from localgate_daemon.ollama import check_ollama, generate


def _mock_ollama(monkeypatch, payload: dict, captured: dict | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if captured is not None:
            captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json=payload)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        "localgate_daemon.ollama.httpx.AsyncClient",
        lambda **_: real_client(transport=httpx.MockTransport(handler)),
    )


def test_generate_sends_think_flag_and_returns_only_the_answer(monkeypatch) -> None:
    captured: dict = {}
    # A reasoning model returns the trace separately; we must surface only `response`.
    _mock_ollama(
        monkeypatch,
        {"response": "408", "thinking": "long trace", "eval_count": 3},
        captured,
    )

    result = asyncio.run(
        generate(
            prompt="x", base_url="http://localhost:11434", model="m", num_ctx=8192, think=True
        )
    )

    assert captured["payload"]["think"] is True
    assert result.response == "408"  # the final answer, not the reasoning trace
    assert result.tokens_estimated == 3


def test_generate_pins_the_context_window_and_reports_prompt_tokens(monkeypatch) -> None:
    # The window must be sent explicitly: left unset, Ollama picks one from available VRAM,
    # which makes a run depend on the machine that produced it.
    captured: dict = {}
    _mock_ollama(
        monkeypatch,
        {"response": "hi", "eval_count": 2, "prompt_eval_count": 11},
        captured,
    )

    result = asyncio.run(
        generate(prompt="x", base_url="http://localhost:11434", model="m", num_ctx=4096)
    )

    assert captured["payload"]["options"]["num_ctx"] == 4096
    assert result.prompt_tokens == 11


def test_generate_warns_when_the_prompt_filled_the_window(monkeypatch, caplog) -> None:
    # Ollama trims from the front and says nothing, so a prompt_eval_count at the ceiling
    # is the only evidence the model never saw the start of the prompt.
    _mock_ollama(monkeypatch, {"response": "hi", "eval_count": 2, "prompt_eval_count": 4096})

    with caplog.at_level(logging.WARNING):
        asyncio.run(
            generate(prompt="x", base_url="http://localhost:11434", model="m", num_ctx=4096)
        )

    assert "truncates from the start" in caplog.text


def test_check_ollama_malformed_base_url_returns_false() -> None:
    # httpx.InvalidURL is not an HTTPError subclass; a malformed base URL must report
    # unreachable instead of crashing /health.
    assert asyncio.run(check_ollama("http://localhost:notaport")) is False


def test_generate_builds_timeout_from_setting(monkeypatch) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"response": "hi", "eval_count": 1})

    real_client = httpx.AsyncClient

    def fake_client(**kwargs):
        captured.update(kwargs)
        return real_client(transport=httpx.MockTransport(handler))

    monkeypatch.setattr("localgate_daemon.ollama.httpx.AsyncClient", fake_client)

    asyncio.run(
        generate(
            prompt="x",
            base_url="http://localhost:11434",
            model="m",
            num_ctx=8192,
            timeout_s=45.0,
        )
    )

    timeout = captured["timeout"]
    assert timeout.read == 45.0
    assert timeout.connect == 10.0  # connect stays short regardless of the budget


def test_generate_stays_quiet_when_the_prompt_fits(monkeypatch, caplog) -> None:
    _mock_ollama(monkeypatch, {"response": "hi", "eval_count": 2, "prompt_eval_count": 12})

    with caplog.at_level(logging.WARNING):
        asyncio.run(
            generate(prompt="x", base_url="http://localhost:11434", model="m", num_ctx=4096)
        )

    assert "truncates from the start" not in caplog.text
