"""Authoritative admission for paid work, backed by migration 0011.

An admission is a one-use authorization, not a reusable provider credential.
Callers reserve a conservative maximum before any side effect and settle only
known consumption. Uncertain work keeps its reservation until reconciliation.
"""
from __future__ import annotations

import logging
import os
import uuid
import json
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

from .supabase_client import supabase

logger = logging.getLogger("bmo.usage")
DAILY_USER_LIMITS = {
    "thinking": 1_000_000, "deep": 200_000, "aeon": 1_000_000,
    "image": 30_000, "tts": 30_000, "transcribe": 3_600,
    "search": 60, "scrape": 60,
}
_scope = ContextVar("bmo_usage_principal", default=None)


class MeteringUnavailable(RuntimeError):
    """No authoritative accounting/configuration: do not start paid work."""


class QuotaExceeded(RuntimeError):
    """A user or global allowance has no room for the requested maximum."""


class AdmissionConflict(RuntimeError):
    """The admission identifier was already consumed or does not match."""


def _identity(user_id: str | None, external_principal: str | None) -> dict:
    import re
    if user_id is not None and external_principal is None:
        return {"p_user_id": str(uuid.UUID(user_id)), "p_external_principal": None}
    if user_id is None and isinstance(external_principal, str) and re.fullmatch(r"wa:[a-f0-9]{64}", external_principal):
        return {"p_user_id": None, "p_external_principal": external_principal}
    raise ValueError("Invalid admission identity")


def _rpc(name: str, parameters: dict):
    try:
        return supabase().rpc(name, parameters).execute().data
    except Exception as error:
        # Do not include JWTs, request bodies, phone numbers or DB error bodies.
        logger.error("metering_unavailable operation=%s error_type=%s", name, type(error).__name__)
        raise MeteringUnavailable("Usage accounting is unavailable. Please try again shortly.") from error


def reserve_usage(user_id: str | None, request_id: str, resource: str, units: int,
                  *, external_principal: str | None = None) -> dict:
    if resource not in DAILY_USER_LIMITS or type(units) is not int or not 0 < units <= 1_000_000_000:
        raise ValueError("Invalid resource reservation")
    parameters = {**_identity(user_id, external_principal), "p_request_id": str(uuid.UUID(request_id)),
                  "p_resource": resource, "p_units": units}
    try:
        global_limit = int(os.environ[f"BMO_GLOBAL_{resource.upper()}_UNITS_PER_DAY"])
        daily_limit = int(os.getenv(f"BMO_USER_{resource.upper()}_UNITS_PER_DAY", DAILY_USER_LIMITS[resource]))
        if global_limit <= 0 or daily_limit <= 0:
            raise ValueError("Budget must be positive")
    except (KeyError, ValueError, TypeError) as error:
        logger.error("metering_configuration_invalid resource=%s", resource)
        raise MeteringUnavailable("This service's usage allowance is not configured.") from error
    parameters.update(p_global_limit=global_limit, p_daily_user_limit=daily_limit)
    result = _rpc("bmo_reserve_usage", parameters)
    if not isinstance(result, dict) or type(result.get("admitted")) is not bool:
        raise MeteringUnavailable("Usage accounting returned an invalid response.")
    if not result["admitted"]:
        reason = result.get("reason")
        if reason in {"user_limit", "resource_user_limit", "global_limit"}:
            logger.info("usage_admission_denied resource=%s reason=%s", resource, reason)
            raise QuotaExceeded("Usage allowance reached. Please try again later.")
        if reason == "request_conflict":
            raise AdmissionConflict("This request has already been admitted.")
        raise MeteringUnavailable("Usage accounting returned an invalid response.")
    if result.get("fresh") is False:
        raise AdmissionConflict("This request has already been admitted.")
    if result.get("fresh") is not True or result.get("request_id") != parameters["p_request_id"] or result.get("reserved_units") != units:
        raise MeteringUnavailable("Usage accounting returned an invalid response.")
    return result


def settle_usage(user_id: str | None, request_id: str, used_units: int,
                 *, external_principal: str | None = None) -> None:
    if type(used_units) is not int or not 0 <= used_units <= 1_000_000_000:
        raise ValueError("Invalid settlement amount")
    _rpc("bmo_settle_usage", {**_identity(user_id, external_principal),
         "p_request_id": str(uuid.UUID(request_id)), "p_used_units": used_units})


def cancel_usage(user_id: str | None, request_id: str, *, external_principal: str | None = None) -> None:
    """Release ONLY an admission known never to have started provider work."""
    settle_usage(user_id, request_id, 0, external_principal=external_principal)


def held_usage(user_id: str) -> list[dict]:
    data = _rpc("bmo_held_usage", {"p_user_id": str(uuid.UUID(user_id))})
    if not isinstance(data, list) or any(not isinstance(row, dict)
        or row.get("model") not in {"thinking", "deep", "aeon", "image"}
        or type(row.get("tokens")) is not int or row["tokens"] < 0
        or not isinstance(row.get("created_at"), str) or row.get("held") is not True for row in data):
        raise MeteringUnavailable("Usage accounting returned an invalid response.")
    return data


@contextmanager
def scope(user_id: str | None, *, external_principal: str | None = None, resource: str | None = None):
    """Bind a verified, server-derived identity inside a background operation."""
    if (user_id is None) == (external_principal is None):
        raise ValueError("One verified identity is required")
    identity = {"p_user_id": user_id, "p_external_principal": external_principal}
    token = _scope.set({**identity, "resource": resource})
    try:
        yield
    finally:
        _scope.reset(token)


def current_identity() -> dict:
    identity = _scope.get()
    if identity is not None:
        return identity
    from flask import g, has_request_context
    if has_request_context() and getattr(g, "current_user", None):
        return {"p_user_id": g.current_user.id, "p_external_principal": None, "resource": None}
    raise MeteringUnavailable("A verified usage identity is required.")


def bound_task(function):
    """Capture identity explicitly; new Python threads do not inherit it."""
    identity = current_identity()
    @wraps(function)
    def run(*args, **kwargs):
        with scope(identity["p_user_id"], external_principal=identity["p_external_principal"], resource=identity["resource"]):
            return function(*args, **kwargs)
    return run


def _finish(identity: dict, request_id: str, used: int, resource: str):
    try:
        settle_usage(identity["p_user_id"], request_id, used, external_principal=identity["p_external_principal"])
    except MeteringUnavailable:
        # The existing reservation remains authoritative. Losing a settlement
        # must neither refund uncertain spend nor discard an answer already made.
        logger.error("usage_settlement_pending request_id=%s resource=%s", request_id, resource)


@contextmanager
def charge(resource: str, units: int):
    """One bounded non-token operation. Uncertain failures retain its charge."""
    identity = current_identity()
    request_id = str(uuid.uuid4())
    reserve_usage(identity["p_user_id"], request_id, resource, units, external_principal=identity["p_external_principal"])
    try:
        yield request_id
    finally:
        _finish(identity, request_id, units, resource)


def paid_http(resource: str, units: int, operation, *args, **kwargs):
    with charge(resource, units):
        return operation(*args, **kwargs)


def _known_total(response, maximum: int) -> int | None:
    usage = getattr(response, "usage", None)
    total = usage.get("total_tokens") if isinstance(usage, dict) else getattr(usage, "total_tokens", None)
    return total if type(total) is int and 0 <= total <= maximum else None


class _BilledStream:
    def __init__(self, stream, identity, request_id, maximum, resource):
        self.stream = stream
        self.iterator = iter(stream)
        self.identity, self.request_id = identity, request_id
        self.maximum, self.resource = maximum, resource
        self.closed, self.finished, self.total = False, False, None

    def __iter__(self):
        return self

    def __next__(self):
        try:
            chunk = next(self.iterator)
        except StopIteration:
            self.finished = True
            self.close()
            raise
        except BaseException:
            self.close()
            raise
        total = _known_total(chunk, self.maximum)
        if total is not None:
            self.total = total
        if any(getattr(choice, "finish_reason", None) for choice in getattr(chunk, "choices", []) or []):
            self.finished = True
        return chunk

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            close = getattr(self.stream, "close", None)
            if close:
                close()
        except Exception as error:
            logger.warning("provider_stream_close_failed error_type=%s", type(error).__name__)
        _finish(self.identity, self.request_id, self.total if self.finished and self.total is not None else self.maximum, self.resource)


def _prompt_maximum(parameters: dict) -> int:
    messages = parameters.get("messages", [])
    maximum = len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) + 1024 + 64 * len(messages)
    images = 0
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict) or part.get("type") not in {"text", "image_url"}:
                raise MeteringUnavailable("This media format does not have a verified usage allowance.")
            images += part["type"] == "image_url"
    if not images:
        return maximum
    # NVIDIA/Google's model card documents visual budgets up to 1120/image.
    # URI bytes alone do not bound tokens for a small compressed/remote image.
    known = {"google/diffusiongemma-26b-a4b-it": 1120}
    try:
        configured = json.loads(os.getenv("BMO_VISION_TOKEN_BUDGETS", "{}"))
        if not isinstance(configured, dict) or any(not isinstance(name, str) or type(value) is not int or not 0 < value <= 1_000_000 for name, value in configured.items()):
            raise ValueError
        model = parameters.get("model", "")
        bound = max(known.get(model, 0), configured.get(model, 0))
        if not bound:
            raise ValueError
    except (ValueError, TypeError):
        logger.error("vision_allowance_unconfigured")
        raise MeteringUnavailable("Image usage checks are unavailable. Please try again later.") from None
    return maximum + images * (bound + 32)


def llm_create(client, parameters: dict, *, resource: str):
    """Admit one SDK request before it starts, including retries/fallbacks.

    UTF-8 serialized prompt bytes + explicit output cap + framing allowance is
    a conservative fallback when the provider does not report trustworthy usage.
    Large image/document payloads must fit the existing weighted allowance too.
    SDK automatic retries must be disabled: each actual attempt needs admission.
    """
    identity = current_identity()
    resource = identity["resource"] or resource
    try:
        output_limit = int(os.getenv("BMO_MAX_LLM_OUTPUT_TOKENS", "4096"))
        if not 1 <= output_limit <= 8192:
            raise ValueError
    except ValueError as error:
        raise MeteringUnavailable("The model output allowance is invalid.") from error
    supplied = parameters.get("max_tokens", output_limit)
    if type(supplied) is not int or supplied <= 0:
        raise ValueError("Invalid model output limit")
    parameters = {**parameters, "max_tokens": min(supplied, output_limit)}
    maximum = _prompt_maximum(parameters) + parameters["max_tokens"]
    request_id = str(uuid.uuid4())
    reserve_usage(identity["p_user_id"], request_id, resource, maximum, external_principal=identity["p_external_principal"])
    try:
        response = client.chat.completions.create(**parameters)
        if parameters.get("stream"):
            return _BilledStream(response, identity, request_id, maximum, resource)
    except BaseException:
        _finish(identity, request_id, maximum, resource)
        raise
    _finish(identity, request_id, _known_total(response, maximum) or maximum, resource)
    return response
