"""One serial, coalescing database writer for a streamed chat turn."""
from __future__ import annotations

import logging
import threading
import time

from .store import is_transient_persistence_error

logger = logging.getLogger("bmo.chat_persistence")
CHECKPOINT_INTERVAL = 1.0
# Generation completion is streamed first. Slow cold database connections must
# have time to confirm the final row before the browser is told saving failed.
FINAL_FLUSH_TIMEOUT = 30.0
RETRY_DELAY = 0.35
MAX_ATTEMPTS = 3


class TurnWriter:
    """Keep only the newest snapshot; database latency never holds up tokens.

    The worker alone creates the user turn and inserts/updates the assistant.
    Finalization closes submissions and serializes the last snapshot after any
    in-flight checkpoint, so stale content cannot overwrite a final response.
    """

    def __init__(self, initialize, write, *, retry_safe=False):
        self._initialize, self._write = initialize, write
        self._retry_safe = retry_safe
        self._condition = threading.Condition()
        self._latest = None
        self._final = False
        self._done = threading.Event()
        self.message = None
        self.error = None
        threading.Thread(target=self._run, name="bmo-chat-persist", daemon=True).start()

    def submit(self, content, reasoning):
        with self._condition:
            if not self._final:
                self._latest = (content, reasoning)
                self._condition.notify()

    def finish(self, content, reasoning, *, timeout=None):
        with self._condition:
            if not self._final:
                self._latest = (content, reasoning)
                self._final = True
                self._condition.notify()
        if not self._done.wait(FINAL_FLUSH_TIMEOUT if timeout is None else timeout):
            return None
        return self.message if self.error is None else None

    def _run(self):
        previous = None
        failed_snapshot = None
        next_checkpoint = 0.0
        try:
            for attempt in range(MAX_ATTEMPTS):
                try:
                    self._initialize()
                    break
                except Exception as exc:
                    if not self._retry_safe or not is_transient_persistence_error(exc) or attempt == MAX_ATTEMPTS - 1:
                        raise
                    time.sleep(RETRY_DELAY)
            while True:
                with self._condition:
                    while True:
                        snapshot, final = self._latest, self._final
                        changed = snapshot is not None and snapshot != previous and snapshot != failed_snapshot
                        nonempty = snapshot and (snapshot[0].strip() or snapshot[1].strip())
                        remaining = next_checkpoint - time.monotonic()
                        if final or (changed and nonempty and remaining <= 0):
                            break
                        self._condition.wait(remaining if changed and nonempty and remaining > 0 else None)
                if snapshot and (snapshot[0].strip() or snapshot[1].strip()) and (snapshot != previous or self.error is not None):
                    attempts = MAX_ATTEMPTS if final and self._retry_safe else 1
                    for attempt in range(attempts):
                        try:
                            self.message = self._write(self.message, *snapshot)
                            self.error = None
                            failed_snapshot = None
                            break
                        except Exception as exc:
                            if not self._retry_safe or not is_transient_persistence_error(exc):
                                raise
                            self.error = exc
                            if final and attempt < attempts - 1:
                                time.sleep(RETRY_DELAY)
                                continue
                            if final:
                                raise
                            # A failed draft must not kill the worker. Retry on
                            # a newer snapshot or finalization, never spin on it.
                            failed_snapshot = snapshot
                            logger.warning("chat checkpoint failed; retaining latest snapshot for recovery", exc_info=True)
                    if failed_snapshot is not None:
                        next_checkpoint = time.monotonic() + CHECKPOINT_INTERVAL
                        continue
                    previous = snapshot
                    next_checkpoint = time.monotonic() + CHECKPOINT_INTERVAL
                if final:
                    return
        except Exception as exc:  # Database failures must not terminate model streaming.
            self.error = exc
            logger.exception("chat turn persistence failed")
        finally:
            self._done.set()
