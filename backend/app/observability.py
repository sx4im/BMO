"""Safe request correlation without logging URLs, credentials or exception bodies."""
import logging

from flask import g, has_request_context

_installed = False


def configure_logging():
    global _installed
    if not _installed:
        previous = logging.getLogRecordFactory()

        def record_factory(*args, **kwargs):
            record = previous(*args, **kwargs)
            record.bimo_request_id = getattr(g, "request_id", "-") if has_request_context() else "-"
            return record

        logging.setLogRecordFactory(record_factory)
        _installed = True
    logging.basicConfig(level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s request_id=%(bimo_request_id)s: %(message)s")
    # INFO request lines can contain signed storage URLs. Keep warnings/errors;
    # application events provide operation/status/type without those URLs.
    for name in ("httpx", "httpcore", "urllib3", "openai"):
        logging.getLogger(name).setLevel(logging.WARNING)
