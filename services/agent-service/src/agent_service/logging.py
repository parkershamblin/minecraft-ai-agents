"""Structured JSON logs to stdout — same discipline as the other services.

Every line carries service; the tick loop adds correlationId via bind().
"""

import logging
import sys

import structlog


def configure_logging(level: str = "info") -> None:
    logging.basicConfig(stream=sys.stdout, level=level.upper(), format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping()[level.upper()]
        ),
    )


logger = structlog.get_logger(service="agent-service")
