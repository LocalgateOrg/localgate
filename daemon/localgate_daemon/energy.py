"""Energy accounting: measured local draw (CodeCarbon) and the avoided-cloud
estimate (EcoLogits). Both degrade to empty results when unavailable."""

import logging
import math
from contextlib import contextmanager
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class EnergyResult:
    energy_kwh: float | None = None  # electricity consumed
    gwp_kg: float | None = None  # kg CO₂-equivalent (Global Warming Potential)


# Measures local hardware energy with CodeCarbon while the wrapped block runs.
# Yields an EnergyResult that stays None when disabled or when codecarbon is missing.
@contextmanager
def measure_local(enabled: bool, grid_zone: str):
    result = EnergyResult()

    if not enabled:
        yield result
        return

    # Lazy import so the daemon starts fast and runs without the energy extra.
    try:
        from codecarbon import OfflineEmissionsTracker
    except ImportError:
        logger.warning("energy enabled but codecarbon is not installed; skipping local energy")
        yield result
        return

    # A broken tracker (e.g. an invalid grid zone) must never break generation, so any
    # setup failure degrades to an empty result, like the missing-import path above.
    try:
        tracker = OfflineEmissionsTracker(
            # Selects the carbon factor from CodeCarbon's static grid-mix table; no network.
            country_iso_code=grid_zone,
            # Skip emissions.csv; final_emissions_data is read directly.
            save_to_file=False,
            log_level="error",
            # Explicit: older codecarbon (v2) defaulted False and hit lock-file conflicts.
            allow_multiple_runs=True,
            # LLM inference loads large weight tensors into RAM; omitting DRAM undercounts.
            rapl_include_dram=True,
        )
        tracker.start()
    except Exception:
        logger.warning("codecarbon tracker failed to start; skipping local energy", exc_info=True)
        yield result
        return

    try:
        yield result
    finally:
        # A stop failure would otherwise mask an in-flight generation error.
        try:
            tracker.stop()
            data = tracker.final_emissions_data
            if data is not None:
                result.energy_kwh = data.energy_consumed
                result.gwp_kg = data.emissions
        except Exception:
            logger.warning(
                "codecarbon tracker failed to stop; energy not recorded", exc_info=True
            )


# Estimates the energy a cloud model would have used for the same output, via EcoLogits.
# Returns an empty EnergyResult when estimation is not possible: no tokens, ecologits
# missing, or model unsupported.
def estimate_cloud(
    provider: str, model: str, output_tokens: int | None, grid_zone: str
) -> EnergyResult:

    if not output_tokens or output_tokens <= 0:
        return EnergyResult()

    # Lazy import so the daemon starts fast and runs without the energy extra.
    try:
        from ecologits.tracers.utils import llm_impacts
    except ImportError:
        logger.warning("energy enabled but ecologits is not installed; skipping cloud estimate")
        return EnergyResult()

    impacts = llm_impacts(
        provider=provider,
        # A model missing from EcoLogits' registry yields an empty ImpactsOutput.
        model_name=model,
        output_token_count=output_tokens,
        # inf makes EcoLogits use the model's own intrinsic latency (tps/ttft from its
        # registry) rather than a fabricated wall-clock value.
        request_latency=math.inf,
        # Affects carbon (gwp) only; energy (kWh) is grid-independent.
        electricity_mix_zone=grid_zone,
    )

    if impacts.energy is None or impacts.gwp is None:
        return EnergyResult()

    return EnergyResult(
        energy_kwh=midpoint(impacts.energy.value),
        gwp_kg=midpoint(impacts.gwp.value),
    )


# EcoLogits returns a RangeValue (min/max) for closed models whose parameter count is
# undisclosed; collapse it to the midpoint. Open models return a plain float.
def midpoint(value):
    if hasattr(value, "min") and hasattr(value, "max"):
        return (value.min + value.max) / 2.0
    return value
