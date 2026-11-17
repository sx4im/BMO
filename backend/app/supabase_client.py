"""Server-side Supabase admin client.

Uses the service-role key, so it can bypass RLS to perform DB and Storage
operations on behalf of any authenticated user. JWT verification (auth.py)
ensures the caller is actually who they claim to be before this layer is
reached, and queries are always scoped by `user_id` in store.py.
"""

from __future__ import annotations

import os
import threading

# Eagerly import httpcore/httpx so their lazy internal import can't race under
# gunicorn -k gthread cold starts, where a fresh worker building its first
# create_client() crashed with "partially initialized module 'httpcore' has no
# attribute 'ConnectionPool'". Importing here forces them fully loaded at boot.
import httpcore  # noqa: F401
import httpx  # noqa: F401
from supabase import Client, ClientOptions, create_client


_client_lock = threading.Lock()
_cached_client = None

# Bound individual network operations below the 30-second save acknowledgment
# wait. These are transport phase limits, not a total transaction deadline.
_DATABASE_TIMEOUT = httpx.Timeout(15.0, connect=5.0, write=10.0, pool=5.0)
_STORAGE_TIMEOUT = httpx.Timeout(20.0, connect=5.0, write=20.0, pool=5.0)


def attachments_bucket() -> str:
    return os.getenv("SUPABASE_STORAGE_BUCKET", "bimo-attachments")


def is_configured() -> bool:
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))


def supabase() -> Client:
    """Reuse one service-role client per process; never sign user sessions in.

    Separate SDK transports preserve each component's base URL. Supabase 2.18
    mutates a supplied shared HTTPX client's base URL when initializing Storage
    and PostgREST, so ClientOptions.httpx_client must not be shared here.
    """
    global _cached_client
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables "
            "are required. Set them in backend/.env or your Render dashboard."
        )
    signature = (os.getpid(), url, key)
    with _client_lock:
        if _cached_client is not None and _cached_client[0] == signature:
            return _cached_client[1]
        client = create_client(url, key, options=ClientOptions(
            auto_refresh_token=False,
            persist_session=False,
            postgrest_client_timeout=_DATABASE_TIMEOUT,
            storage_client_timeout=20,
        ))
        # Warm the SDK's lazy components while locked before concurrent callers
        # can receive them. HTTPX sessions support concurrent requests.
        client.postgrest.session.timeout = _DATABASE_TIMEOUT
        client.storage.session.timeout = _STORAGE_TIMEOUT
        # This pinned SDK exposes no separate Auth timeout option. Its admin
        # API uses this same transport; no user session state is modified.
        client.auth._http_client.timeout = _DATABASE_TIMEOUT
        # Retain only the current configuration. Existing callers can finish
        # with an older client, so do not close it during a credential rotation.
        _cached_client = (signature, client)
        return client
