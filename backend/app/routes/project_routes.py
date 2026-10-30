"""Projects and Project Files REST API for BMO."""

from __future__ import annotations

import logging
import os
import secrets
from typing import Optional

from flask import Blueprint, jsonify, request

from .. import project_service, store
from ..auth import require_user
from ..config import (
    MAX_PROJECT_FILE_SIZE,
    PROJECT_KNOWLEDGE_BUDGET_TOKENS,
)
from ..limiter import limiter
from .helpers import bad_request

logger = logging.getLogger("bmo.routes.projects")

project_bp = Blueprint("project_routes", __name__)


# ---------- Project CRUD ----------

@project_bp.get("/projects")
@require_user
def list_projects_endpoint(user):
    include_archived = request.args.get("archived", "false").lower() == "true"
    projects = store.list_projects(user.id, include_archived=include_archived)
    stats = store.get_projects_file_stats(user.id)
    result = []
    for p in projects:
        p_stats = stats.get(p["id"], {"file_count": 0, "tokens_used": 0})
        result.append({
            **p,
            "file_count": p_stats["file_count"],
            "tokens_used": p_stats["tokens_used"],
            "token_budget": PROJECT_KNOWLEDGE_BUDGET_TOKENS,
        })
    return jsonify(result)


@project_bp.post("/projects")
@require_user
def create_project_endpoint(user):
    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    if not name or not isinstance(name, str) or not name.strip():
        return bad_request("name is required and must be a non-empty string", 422)
    if len(name.strip()) > 100:
        return bad_request("name too long (max 100 chars)", 422)

    description = payload.get("description", "")
    if not isinstance(description, str):
        return bad_request("description must be a string", 422)
    if len(description) > 500:
        return bad_request("description too long (max 500 chars)", 422)

    instructions = payload.get("instructions", "")
    if not isinstance(instructions, str):
        return bad_request("instructions must be a string", 422)
    if len(instructions) > 8000:
        return bad_request("instructions too long (max 8000 chars)", 422)

    try:
        project = store.create_project(
            user.id,
            name=name.strip(),
            description=description.strip(),
            instructions=instructions.strip(),
        )
        return jsonify({
            **project,
            "file_count": 0,
            "tokens_used": 0,
            "token_budget": PROJECT_KNOWLEDGE_BUDGET_TOKENS,
        }), 201
    except Exception as exc:
        logger.exception("Failed to create project: %s", exc)
        return bad_request("Could not create project", 500)


@project_bp.get("/projects/<project_id>")
@require_user
def get_project_endpoint(user, project_id):
    project = store.get_project(project_id, user.id)
    if not project:
        return bad_request("project not found", 404)

    files = store.list_project_files(project_id, user.id)
    tokens_used = sum(f.get("token_estimate", 0) for f in files)
    conversations = store.list_project_conversations(project_id, user.id)

    return jsonify({
        **project,
        "files": files,
        "tokens_used": tokens_used,
        "token_budget": PROJECT_KNOWLEDGE_BUDGET_TOKENS,
        "conversations": conversations,
    })


@project_bp.patch("/projects/<project_id>")
@require_user
def update_project_endpoint(user, project_id):
    project = store.get_project(project_id, user.id)
    if not project:
        return bad_request("project not found", 404)

    payload = request.get_json(silent=True) or {}
    patch = {}

    if "name" in payload:
        name = payload["name"]
        if not isinstance(name, str) or not name.strip():
            return bad_request("name must be a non-empty string", 422)
        if len(name.strip()) > 100:
            return bad_request("name too long (max 100 chars)", 422)
        patch["name"] = name.strip()

    if "description" in payload:
        desc = payload["description"]
        if not isinstance(desc, str):
            return bad_request("description must be a string", 422)
        if len(desc) > 500:
            return bad_request("description too long (max 500 chars)", 422)
        patch["description"] = desc.strip()

    if "instructions" in payload:
        inst = payload["instructions"]
        if not isinstance(inst, str):
            return bad_request("instructions must be a string", 422)
        if len(inst) > 8000:
            return bad_request("instructions too long (max 8000 chars)", 422)
        patch["instructions"] = inst.strip()

    if "archived" in payload:
        if not isinstance(payload["archived"], bool):
            return bad_request("archived must be a boolean", 422)
        patch["archived"] = payload["archived"]

    updated = store.update_project(project_id, user.id, patch)
    return jsonify(updated)


@project_bp.delete("/projects/<project_id>")
@require_user
def delete_project_endpoint(user, project_id):
    deleted = store.delete_project(project_id, user.id)
    if not deleted:
        return bad_request("project not found", 404)
    return jsonify({"status": "deleted", "id": project_id})


# ---------- Project Files (Knowledge) ----------

@project_bp.get("/projects/<project_id>/files")
@require_user
def list_files_endpoint(user, project_id):
    if not store.get_project(project_id, user.id):
        return bad_request("project not found", 404)
    files = store.list_project_files(project_id, user.id)
    tokens_used = sum(f.get("token_estimate", 0) for f in files)
    return jsonify({
        "files": files,
        "tokens_used": tokens_used,
        "token_budget": PROJECT_KNOWLEDGE_BUDGET_TOKENS,
    })


@project_bp.post("/projects/<project_id>/files")
@limiter.limit("30 per minute")
@require_user
def upload_file_endpoint(user, project_id):
    project = store.get_project(project_id, user.id)
    if not project:
        return bad_request("project not found", 404)

    filename = ""
    file_bytes = b""

    # Support multipart/form-data upload
    if "file" in request.files:
        f = request.files["file"]
        filename = f.filename or ""
        file_bytes = f.read()
    else:
        # Support JSON payload upload: { "filename": "...", "content": "..." }
        payload = request.get_json(silent=True) or {}
        filename = payload.get("filename") or ""
        raw_content = payload.get("content") or ""
        if isinstance(raw_content, str):
            file_bytes = raw_content.encode("utf-8")
        elif isinstance(raw_content, bytes):
            file_bytes = raw_content

    if not filename or not file_bytes:
        return bad_request("No file provided", 422)

    current_tokens = store.get_project_token_usage(project_id, user.id)

    try:
        clean_name, mime_type, extracted_text, size_bytes, token_estimate = (
            project_service.validate_and_process_upload(
                filename=filename,
                file_bytes=file_bytes,
                current_project_tokens=current_tokens,
            )
        )
    except ValueError as val_err:
        return bad_request(str(val_err), 422)
    except Exception as exc:
        logger.exception("Upload validation failed: %s", exc)
        return bad_request("Could not process file upload", 500)

    # Upload to Supabase Storage in private attachment bucket
    # Path: <user_id>/projects/<project_id>/<random_hex>_<clean_name>
    safe_path = f"{user.id}/projects/{project_id}/{secrets.token_hex(6)}_{clean_name}"
    try:
        bucket = store.attachments_bucket()
        store.supabase().storage.from_(bucket).upload(
            path=safe_path,
            file=file_bytes,
            file_options={"content-type": mime_type, "upsert": "false"},
        )
    except Exception as exc:
        logger.exception("Storage upload failed for %s: %s", safe_path, exc)
        return bad_request("Could not store file", 500)

    try:
        record = store.add_project_file(
            project_id=project_id,
            user_id=user.id,
            filename=clean_name,
            mime_type=mime_type,
            size_bytes=size_bytes,
            storage_path=safe_path,
            extracted_text=extracted_text,
            token_estimate=token_estimate,
        )
        total_tokens = current_tokens + token_estimate
        return jsonify({
            "file": record,
            "tokens_used": total_tokens,
            "token_budget": PROJECT_KNOWLEDGE_BUDGET_TOKENS,
        }), 201
    except Exception as exc:
        logger.exception("Failed to insert project file record: %s", exc)
        # Clean up uploaded storage file on DB error
        store._delete_storage_paths([safe_path])
        return bad_request("Could not save file record", 500)


@project_bp.delete("/projects/<project_id>/files/<file_id>")
@require_user
def delete_file_endpoint(user, project_id, file_id):
    if not store.get_project(project_id, user.id):
        return bad_request("project not found", 404)

    deleted = store.delete_project_file(file_id, user.id)
    if not deleted:
        return bad_request("file not found", 404)

    tokens_used = store.get_project_token_usage(project_id, user.id)
    return jsonify({
        "status": "deleted",
        "file_id": file_id,
        "tokens_used": tokens_used,
        "token_budget": PROJECT_KNOWLEDGE_BUDGET_TOKENS,
    })


# ---------- Project Chats ----------

@project_bp.get("/projects/<project_id>/chats")
@require_user
def list_project_chats_endpoint(user, project_id):
    if not store.get_project(project_id, user.id):
        return bad_request("project not found", 404)
    chats = store.list_project_conversations(project_id, user.id)
    return jsonify(chats)
