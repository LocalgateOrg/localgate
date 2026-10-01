"""SQLite telemetry: events and HITL-decision tables plus the /stats aggregation."""

import sqlite3
from pathlib import Path

from .schemas import ClassifyResponse, FeedbackRequest, GenerateResponse, StatsResponse


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # check_same_thread=False: handlers run on Starlette's threadpool. The sqlite3 module
    # serializes access, and every write here is a single statement, so this is safe.
    connection = sqlite3.connect(db_path, check_same_thread=False)

    connection.row_factory = sqlite3.Row

    initialize(connection)

    return connection


# Idempotent; called on every startup.
def initialize(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY,
            kind TEXT NOT NULL,
            route TEXT,
            reason TEXT,
            model TEXT,
            latency_ms REAL NOT NULL,
            local_energy_kwh REAL,
            cloud_energy_kwh REAL,
            local_gwp_kg REAL,
            cloud_gwp_kg REAL,
            request_id TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    # CREATE TABLE IF NOT EXISTS leaves an existing table as it was, so older databases
    # need newer columns added in place. Names are module-local literals, never user input.
    _add_missing_columns(
        connection,
        "events",
        {"tokens_estimated": "INTEGER", "prompt_tokens": "INTEGER", "request_id": "TEXT"},
    )
    # HITL decisions live in their own table — no prompt text, just the verdict
    # and the classifier basis behind it.
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS hitl_decisions (
            id INTEGER PRIMARY KEY,
            decision TEXT NOT NULL,
            provider TEXT,
            reason TEXT,
            confidence REAL,
            request_id TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    _add_missing_columns(connection, "hitl_decisions", {"request_id": "TEXT"})
    connection.commit()


def _add_missing_columns(
    connection: sqlite3.Connection, table: str, columns: dict[str, str]
) -> None:
    existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
    for name, declaration in columns.items():
        if name not in existing:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")


def record_classification(
    connection: sqlite3.Connection, result: ClassifyResponse, request_id: str = ""
) -> None:
    connection.execute(
        """
        INSERT INTO events (kind, route, reason, latency_ms, request_id)
        VALUES ('classification', ?, ?, ?, ?)
        """,
        (result.route, result.reason, result.latency_ms, request_id),
    )
    connection.commit()


def record_generation(
    connection: sqlite3.Connection, result: GenerateResponse, request_id: str = ""
) -> None:
    connection.execute(
        """
        INSERT INTO events (
            kind, model, latency_ms, local_energy_kwh, cloud_energy_kwh, local_gwp_kg,
            cloud_gwp_kg, tokens_estimated, prompt_tokens, request_id
        )
        VALUES ('generation', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            result.model,
            result.latency_ms,
            result.local_energy_kwh,
            result.cloud_energy_kwh,
            result.local_gwp_kg,
            result.cloud_gwp_kg,
            result.tokens_estimated,
            result.prompt_tokens,
            request_id,
        ),
    )
    connection.commit()


# No prompt text is stored by design.
def record_feedback(connection: sqlite3.Connection, feedback: FeedbackRequest) -> None:
    connection.execute(
        """
        INSERT INTO hitl_decisions (decision, provider, reason, confidence, request_id)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            feedback.decision,
            feedback.provider,
            feedback.reason,
            feedback.confidence,
            feedback.request_id,
        ),
    )
    connection.commit()


def stats(connection: sqlite3.Connection) -> StatsResponse:
    row = connection.execute(
        """
        SELECT
            SUM(kind = 'classification') AS classifications,
            SUM(kind = 'generation') AS generations,
            SUM(route = 'local') AS local_routes,
            SUM(route = 'cloud') AS cloud_routes,
            AVG(latency_ms) AS average_latency_ms,
            SUM(local_energy_kwh) AS local_energy_kwh,
            SUM(cloud_energy_kwh) AS cloud_energy_kwh,
            SUM(local_gwp_kg) AS local_gwp_kg,
            SUM(cloud_gwp_kg) AS cloud_gwp_kg
        FROM events
        """
    ).fetchone()

    # SQL SUM of zero rows returns NULL, not 0, so fall back to 0 for count fields.
    classifications = int(row["classifications"] or 0)
    generations = int(row["generations"] or 0)
    local_routes = int(row["local_routes"] or 0)
    cloud_routes = int(row["cloud_routes"] or 0)

    # These fields can legitimately be None if no data exists yet.
    average_latency_ms = (
        round(float(row["average_latency_ms"]), 3)
        if row["average_latency_ms"] is not None
        else None
    )

    local_energy_kwh = (
        float(row["local_energy_kwh"])
        if row["local_energy_kwh"] is not None
        else None
    )

    cloud_energy_kwh = (
        float(row["cloud_energy_kwh"])
        if row["cloud_energy_kwh"] is not None
        else None
    )

    local_gwp_kg = (
        float(row["local_gwp_kg"])
        if row["local_gwp_kg"] is not None
        else None
    )

    cloud_gwp_kg = (
        float(row["cloud_gwp_kg"])
        if row["cloud_gwp_kg"] is not None
        else None
    )

    # override_rate is the share of gated decisions the human deliberately sent to cloud.
    hitl = connection.execute(
        """
        SELECT
            COUNT(*) AS total,
            SUM(decision = 'overrode_cloud') AS overrides
        FROM hitl_decisions
        """
    ).fetchone()
    hitl_decisions = int(hitl["total"] or 0)
    override_rate = (
        round(int(hitl["overrides"] or 0) / hitl_decisions, 3)
        if hitl_decisions
        else None
    )

    return StatsResponse(
        classifications=classifications,
        generations=generations,
        local_routes=local_routes,
        cloud_routes=cloud_routes,
        average_latency_ms=average_latency_ms,
        local_energy_kwh=local_energy_kwh,
        cloud_energy_kwh=cloud_energy_kwh,
        local_gwp_kg=local_gwp_kg,
        cloud_gwp_kg=cloud_gwp_kg,
        hitl_decisions=hitl_decisions,
        override_rate=override_rate,
    )
