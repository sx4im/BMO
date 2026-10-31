"""Small SQLite registry shared by Gunicorn workers on the same host."""
from __future__ import annotations

import os
import sqlite3
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def _database():
    directory = Path(os.getenv("BMO_STATE_DIR", str(Path(tempfile.gettempdir()) / f"bmo-{os.getuid()}")))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / "streams.sqlite3"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(descriptor)
    connection = sqlite3.connect(path, timeout=5)
    try:
        with connection:
            connection.execute("""CREATE TABLE IF NOT EXISTS streams (
                user_id TEXT NOT NULL, stream_id TEXT NOT NULL, registration TEXT NOT NULL,
                cancelled INTEGER NOT NULL DEFAULT 0, expires_at REAL NOT NULL,
                PRIMARY KEY (user_id, stream_id)
            )""")
            yield connection
    finally:
        connection.close()


class StreamCancellation(threading.Event):
    def __init__(self, user_id: str, stream_id: str, registration: str):
        super().__init__()
        self.user_id, self.stream_id, self.registration = user_id, stream_id, registration
        self._last_poll = 0.0

    def is_set(self) -> bool:
        if not super().is_set() and time.monotonic() - self._last_poll >= 0.1:
            self._last_poll = time.monotonic()
            with _database() as connection:
                row = connection.execute(
                    "SELECT cancelled FROM streams WHERE registration = ?", (self.registration,)
                ).fetchone()
            if row is None or row[0]:
                self.set()
        return super().is_set()

    def wait(self, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self.is_set():
            remaining = 0.1 if deadline is None else min(0.1, deadline - time.monotonic())
            if remaining <= 0:
                return self.is_set()
            super().wait(remaining)
        return True


def register(stream_id: str, user_id: str) -> StreamCancellation:
    registration = uuid.uuid4().hex
    with _database() as connection:
        connection.execute("DELETE FROM streams WHERE expires_at < ?", (time.time(),))
        if connection.execute("SELECT count(*) FROM streams").fetchone()[0] >= 512:
            raise RuntimeError("Too many active streams. Please try again shortly.")
        try:
            connection.execute("INSERT INTO streams VALUES (?, ?, ?, 0, ?)",
                               (user_id, stream_id, registration, time.time() + 3600))
        except sqlite3.IntegrityError as exc:
            raise ValueError("stream_id is already active") from exc
    return StreamCancellation(user_id, stream_id, registration)


def signal(stream_id: str, user_id: str) -> bool:
    with _database() as connection:
        result = connection.execute(
            "UPDATE streams SET cancelled = 1 WHERE user_id = ? AND stream_id = ? AND expires_at >= ?",
            (user_id, stream_id, time.time()),
        )
        return result.rowcount > 0


def unregister(event: StreamCancellation) -> None:
    with _database() as connection:
        connection.execute("DELETE FROM streams WHERE registration = ?", (event.registration,))
