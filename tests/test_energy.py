import builtins
import sys
from types import SimpleNamespace

import pytest
from localgate_daemon.energy import EnergyResult, estimate_cloud, measure_local

REFERENCE_MODEL = "gpt-5.4-2026-03-05"

# CodeCarbon reports kilowatt-hours and kilograms of CO₂eq as two separate physical
# quantities. Deliberately unequal and non-round so a transposition cannot survive.
FAKE_LOCAL_KWH = 0.0431
FAKE_LOCAL_KG = 0.0177

# EcoLogits returns a min/max range for closed models; the midpoint of this one is
# 0.0032, again distinct from the carbon figure.
FAKE_CLOUD_KWH_RANGE = SimpleNamespace(min=0.0021, max=0.0043)
FAKE_CLOUD_KWH_MIDPOINT = 0.0032
FAKE_CLOUD_KG = 0.00087


def _block_import(monkeypatch, blocked_prefix: str) -> None:
    real_import = builtins.__import__

    def blocker(name, *args, **kwargs):
        if name.startswith(blocked_prefix):
            raise ImportError(f"mocked missing {blocked_prefix}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocker)


# Stands in for codecarbon so the success path is exercised without real hardware
# counters; returns the list the started trackers are recorded in.
def _install_fake_codecarbon(monkeypatch) -> list:
    trackers: list = []

    class FakeTracker:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.stopped = False
            self.final_emissions_data = None
            trackers.append(self)

        def start(self) -> None:
            pass

        def stop(self) -> None:
            self.stopped = True
            self.final_emissions_data = SimpleNamespace(
                energy_consumed=FAKE_LOCAL_KWH, emissions=FAKE_LOCAL_KG
            )

    monkeypatch.setitem(
        sys.modules, "codecarbon", SimpleNamespace(OfflineEmissionsTracker=FakeTracker)
    )
    return trackers


def test_measure_local_disabled():
    with measure_local(False, "WOR") as energy:
        pass
    assert isinstance(energy, EnergyResult)
    assert energy.energy_kwh is None


def test_measure_local_enabled_without_codecarbon(monkeypatch):
    _block_import(monkeypatch, "codecarbon")

    with measure_local(True, "WOR") as energy:
        pass
    assert energy.energy_kwh is None


def test_measure_local_reports_the_kwh_reading_as_energy_and_the_kg_reading_as_carbon(
    monkeypatch,
):
    # Transposing these publishes kilograms of CO₂ as the daemon's kilowatt-hour figure.
    trackers = _install_fake_codecarbon(monkeypatch)

    with measure_local(True, "DEU") as energy:
        # The tracker is still running here; the reading only lands once it stops.
        assert energy.energy_kwh is None

    assert energy.energy_kwh == FAKE_LOCAL_KWH
    assert energy.gwp_kg == FAKE_LOCAL_KG
    assert trackers[0].stopped is True


def test_measure_local_passes_the_grid_zone_and_counts_dram(monkeypatch):
    # Omitting DRAM undercounts inference, which loads weight tensors into RAM.
    trackers = _install_fake_codecarbon(monkeypatch)

    with measure_local(True, "DEU"):
        pass

    assert trackers[0].kwargs["country_iso_code"] == "DEU"
    assert trackers[0].kwargs["rapl_include_dram"] is True


def test_estimate_cloud_reports_the_kwh_range_midpoint_as_energy_and_the_kg_as_carbon(
    monkeypatch,
):
    captured: dict = {}

    def fake_llm_impacts(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            energy=SimpleNamespace(value=FAKE_CLOUD_KWH_RANGE),
            gwp=SimpleNamespace(value=FAKE_CLOUD_KG),
        )

    monkeypatch.setitem(
        sys.modules,
        "ecologits.tracers.utils",
        SimpleNamespace(llm_impacts=fake_llm_impacts),
    )

    result = estimate_cloud("openai", REFERENCE_MODEL, 1000, "WOR")

    assert result.energy_kwh == pytest.approx(FAKE_CLOUD_KWH_MIDPOINT)
    assert result.gwp_kg == FAKE_CLOUD_KG
    assert captured["model_name"] == REFERENCE_MODEL
    assert captured["output_token_count"] == 1000
    assert captured["electricity_mix_zone"] == "WOR"


def test_estimate_cloud_with_supported_model():
    pytest.importorskip("ecologits", reason="Requires the energy extra")
    result = estimate_cloud("openai", REFERENCE_MODEL, 1000, "WOR")
    assert result.energy_kwh is not None
    assert result.gwp_kg is not None
    assert result.energy_kwh > 0
    assert result.gwp_kg > 0


def test_estimate_cloud_with_unsupported_model():
    pytest.importorskip("ecologits", reason="Requires the energy extra")
    result = estimate_cloud("openai", "unsupported-model-999", 1000, "WOR")
    assert result.energy_kwh is None
    assert result.gwp_kg is None


def test_estimate_cloud_none_without_tokens():
    assert estimate_cloud("openai", REFERENCE_MODEL, None, "WOR") == EnergyResult()


def test_estimate_cloud_none_with_zero_tokens():
    assert estimate_cloud("openai", REFERENCE_MODEL, 0, "WOR") == EnergyResult()


def test_estimate_cloud_none_with_negative_tokens():
    assert estimate_cloud("openai", REFERENCE_MODEL, -5, "WOR") == EnergyResult()


def test_estimate_cloud_without_ecologits_does_not_crash(monkeypatch):
    # Regression: a default install (no energy extra) must not raise on the cloud path.
    _block_import(monkeypatch, "ecologits")

    assert estimate_cloud("openai", REFERENCE_MODEL, 1000, "WOR") == EnergyResult()


def test_grid_zone_changes_carbon_not_energy():
    pytest.importorskip("ecologits", reason="Requires the energy extra")
    # Energy is grid-independent; only carbon scales with the electricity mix.
    fra = estimate_cloud("openai", REFERENCE_MODEL, 1000, "FRA")
    pol = estimate_cloud("openai", REFERENCE_MODEL, 1000, "POL")
    assert fra.energy_kwh == pol.energy_kwh
    assert fra.gwp_kg != pol.gwp_kg
