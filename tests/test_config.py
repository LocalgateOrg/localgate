import os
from pathlib import Path

import pytest
from localgate_daemon.classifier import route_from_margin
from localgate_daemon.config import Settings
from pydantic import ValidationError


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # Settings reads LOCALGATE_* from the ambient environment, so a developer's shell would
    # otherwise decide what "the default" is.
    for name in list(os.environ):
        if name.startswith("LOCALGATE_"):
            monkeypatch.delenv(name)


def make_settings(**overrides: object) -> Settings:
    # _env_file=None keeps a checked-out .env from shadowing the declared defaults.
    return Settings(_env_file=None, **overrides)


def test_defaults_match_the_documented_values() -> None:
    settings = make_settings()

    assert settings.host == "127.0.0.1"
    assert settings.port == 8400
    assert settings.ollama_base_url == "http://localhost:11434"
    assert settings.ollama_model == "gemma4:e2b"
    assert settings.ollama_think is False
    assert settings.embedding_model == "BAAI/bge-small-en-v1.5"
    assert settings.classifier_threshold == 0.05
    assert settings.db_path == Path.home() / ".localgate/localgate.sqlite"
    assert settings.enable_energy is False
    assert settings.cloud_reference_provider == "openai"
    assert settings.cloud_reference_model == "gpt-5.4-2026-03-05"
    assert settings.energy_grid_zone == "WOR"
    assert settings.log_level == "INFO"


@pytest.mark.usefixtures("clean_env")
def test_default_threshold_leaves_a_typical_margin_unambiguous() -> None:
    # Guards the default's meaning, not just its digits: at 0.5 nearly every centroid
    # margin falls inside the ambiguous band and local routing quietly stops happening.
    threshold = make_settings().classifier_threshold

    assert route_from_margin(0.2, threshold) == ("local", "centroid_simple")
    assert route_from_margin(0.02, threshold) == ("cloud", "ambiguous_fallback")


@pytest.mark.usefixtures("clean_env")
@pytest.mark.parametrize("threshold", [1.5, -0.1, 2.0])
def test_out_of_range_threshold_is_rejected(threshold: float) -> None:
    with pytest.raises(ValidationError):
        make_settings(classifier_threshold=threshold)


@pytest.mark.usefixtures("clean_env")
@pytest.mark.parametrize("threshold", [0.0, 0.05, 1.0])
def test_in_range_threshold_is_accepted(threshold: float) -> None:
    assert make_settings(classifier_threshold=threshold).classifier_threshold == threshold


@pytest.mark.usefixtures("clean_env")
def test_threshold_env_override_is_read_and_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOCALGATE_CLASSIFIER_THRESHOLD", "0.2")

    assert make_settings().classifier_threshold == 0.2

    monkeypatch.setenv("LOCALGATE_CLASSIFIER_THRESHOLD", "1.5")

    with pytest.raises(ValidationError):
        make_settings()
