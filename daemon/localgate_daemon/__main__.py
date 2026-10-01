"""CLI entry point: configure logging and run the daemon under uvicorn."""

import argparse
import logging

import uvicorn

from .config import Settings


def configure_logging(level: str) -> None:
    # An unknown level name raises ValueError here, at startup, instead of being coerced.
    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("localgate_daemon").setLevel(level.upper())


def main() -> None:
    settings = Settings()

    parser = argparse.ArgumentParser(description="Run the LocalGate daemon.")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    args = parser.parse_args()

    configure_logging(settings.log_level)

    logging.getLogger(__name__).info(
        "starting daemon host=%s port=%s model=%s db_path=%s log_level=%s",
        args.host,
        args.port,
        settings.ollama_model,
        settings.db_path,
        settings.log_level.upper(),
    )

    uvicorn.run(
        "localgate_daemon.app:app",
        host=args.host,
        port=args.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
