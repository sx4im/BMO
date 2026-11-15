"""One serial, coalescing database writer for a streamed chat turn."""
from __future__ import annotations

import logging
import threading
import time

logger = logging.getLogger("bmo.chat_persistence")
CHECKPOINT_INTERVAL = 1.0
FINAL_FLUSH_TIMEOUT = 2.0


class TurnWriter:
    """Keep only the newest snapshot; database latency never holds up tokens.

    The worker alone creates the user turn and inserts/updates the assistant.
    Finalization closes submissions and serializes the last snapshot after any
    in-flight checkpoint, so stale content cannot overwrite a final response.
    """

    def __init__(self, initialize, write):
        self._initialize, self._write = initialize, write
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
        next_checkpoint = 0.0
        try:
            self._initialize()
            while True:
                with self._condition:
                    while True:
                        snapshot, final = self._latest, self._final
                        changed = snapshot is not None and snapshot != previous
                        nonempty = snapshot and (snapshot[0].strip() or snapshot[1].strip())
                        remaining = next_checkpoint - time.monotonic()
                        if final or (changed and nonempty and remaining <= 0):
                            break
                        self._condition.wait(remaining if changed and nonempty and remaining > 0 else None)
                if snapshot and (snapshot[0].strip() or snapshot[1].strip()) and snapshot != previous:
                    self.message = self._write(self.message, *snapshot)
                    previous = snapshot
                    next_checkpoint = time.monotonic() + CHECKPOINT_INTERVAL
                if final:
                    return
        except Exception as exc:  # Database failures must not terminate model streaming.
            self.error = exc
            logger.exception("chat turn persistence failed")
        finally:
            self._done.set()
