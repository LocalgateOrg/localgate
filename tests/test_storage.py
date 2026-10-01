from pathlib import Path

import pytest
from localgate_daemon.schemas import ClassifyResponse, GenerateResponse
from localgate_daemon.storage import connect, record_classification, record_generation, stats


def test_storage_records_events(tmp_path: Path) -> None:
    connection = connect(tmp_path / "events.sqlite")
    record_classification(
        connection,
        ClassifyResponse(
            route="local",
            confidence=0.7,
            reason="centroid_simple",
            latency_ms=3.0,
        ),
    )
    record_generation(
        connection,
        GenerateResponse(
            response="hello",
            model="test-model",
            latency_ms=7.0,
            local_energy_kwh=None,
            tokens_estimated=None,
        ),
    )

    result = stats(connection)

    assert result.classifications == 1
    assert result.generations == 1
    assert result.local_routes == 1
    assert result.average_latency_ms == 5.0


def test_generation_energy_survives_the_round_trip_under_its_own_name(tmp_path: Path) -> None:
    # Four distinct, non-round values: the INSERT is positional, so a pair of swapped
    # columns would report the avoided-cloud estimate as measured local draw.
    connection = connect(tmp_path / "energy.sqlite")
    record_generation(
        connection,
        GenerateResponse(
            response="hello",
            model="test-model",
            latency_ms=7.0,
            local_energy_kwh=0.000412,
            cloud_energy_kwh=0.008317,
            local_gwp_kg=0.000173,
            cloud_gwp_kg=0.003941,
            tokens_estimated=128,
        ),
    )

    result = stats(connection)

    assert result.local_energy_kwh == 0.000412
    assert result.cloud_energy_kwh == 0.008317
    assert result.local_gwp_kg == 0.000173
    assert result.cloud_gwp_kg == 0.003941


def test_energy_totals_accumulate_across_generations(tmp_path: Path) -> None:
    connection = connect(tmp_path / "totals.sqlite")
    for local_kwh, cloud_kwh in ((0.000412, 0.008317), (0.000205, 0.004106)):
        record_generation(
            connection,
            GenerateResponse(
                response="hello",
                model="test-model",
                latency_ms=7.0,
                local_energy_kwh=local_kwh,
                cloud_energy_kwh=cloud_kwh,
            ),
        )

    result = stats(connection)

    assert result.local_energy_kwh == pytest.approx(0.000617)
    assert result.cloud_energy_kwh == pytest.approx(0.012423)


def test_empty_database_returns_zeroes(tmp_path: Path) -> None:
    connection = connect(tmp_path / "empty.sqlite")

    result = stats(connection)

    assert result.classifications == 0
    assert result.generations == 0
    assert result.local_routes == 0
    assert result.cloud_routes == 0
    assert result.average_latency_ms is None
    assert result.local_energy_kwh is None


def test_cloud_route_is_counted(tmp_path: Path) -> None:
    connection = connect(tmp_path / "cloud.sqlite")
    record_classification(
        connection,
        ClassifyResponse(
            route="cloud",
            confidence=1.0,
            reason="rule_web_required",
            latency_ms=2.0,
        ),
    )

    result = stats(connection)

    assert result.cloud_routes == 1
    assert result.local_routes == 0
