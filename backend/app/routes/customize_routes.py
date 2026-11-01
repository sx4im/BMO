"""Owner-scoped Customize preferences and text-only Skills API."""
from __future__ import annotations

import io
from flask import Blueprint, jsonify, request, send_file
from postgrest.exceptions import APIError

from .. import skill_service, store
from ..auth import require_user
from ..limiter import limiter
from .helpers import bad_request

customize_bp = Blueprint("customize_routes", __name__)


def owned_skill(skill_id, user_id):
    parsed = skill_service.valid_id(skill_id)
    return store.get_skill(parsed, user_id) if parsed else None


@customize_bp.errorhandler(ValueError)
def validation_error(error):
    return bad_request(str(error), 422)


@customize_bp.errorhandler(APIError)
def database_error(error):
    if error.code == "23505":
        return bad_request("You already have a skill with this name", 409)
    raise error


@customize_bp.get("/preferences")
@require_user
def get_preferences(user):
    return jsonify(store.get_preferences(user.id))


@customize_bp.put("/preferences")
@require_user
def save_preferences(user):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return bad_request("instructions must be an object containing text", 422)
    instructions = skill_service.validate_text(payload.get("instructions"), "instructions", 4000)
    return jsonify(store.save_preferences(user.id, instructions))


@customize_bp.get("/skills")
@require_user
def list_skills(user):
    return jsonify(store.list_skills(user.id))


@customize_bp.post("/skills")
@require_user
def create_skill(user):
    values = skill_service.validate_skill(request.get_json(silent=True))
    return jsonify(store.create_skill(user.id, values, [])), 201


@customize_bp.post("/skills/upload")
@limiter.limit("30 per minute")
@require_user
def upload_skill(user):
    upload = request.files.get("file")
    if not upload:
        return bad_request("file is required", 422)
    values, files = skill_service.import_skill(upload.filename or "", upload.read(skill_service.MAX_UPLOAD_BYTES + 1))
    return jsonify(store.create_skill(user.id, values, files)), 201


@customize_bp.get("/skills/<skill_id>")
@require_user
def get_skill(user, skill_id):
    skill = owned_skill(skill_id, user.id)
    if not skill:
        return bad_request("skill not found", 404)
    return jsonify({**skill, "files": store.list_skill_files(skill["id"], user.id)})


@customize_bp.put("/skills/<skill_id>")
@require_user
def update_skill(user, skill_id):
    skill = owned_skill(skill_id, user.id)
    if not skill:
        return bad_request("skill not found", 404)
    values = skill_service.validate_skill(request.get_json(silent=True))
    updated = store.update_skill(skill["id"], user.id, values)
    return jsonify(updated) if updated else bad_request("skill not found", 404)


@customize_bp.put("/skills/<skill_id>/enabled")
@require_user
def enable_skill(user, skill_id):
    skill = owned_skill(skill_id, user.id)
    if not skill:
        return bad_request("skill not found", 404)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or type(payload.get("enabled")) is not bool:
        return bad_request("enabled must be a boolean", 422)
    updated = store.update_skill(skill["id"], user.id, {"enabled": payload["enabled"]})
    return jsonify(updated) if updated else bad_request("skill not found", 404)


@customize_bp.delete("/skills/<skill_id>")
@require_user
def delete_skill(user, skill_id):
    skill = owned_skill(skill_id, user.id)
    if not skill or not store.delete_skill(skill["id"], user.id):
        return bad_request("skill not found", 404)
    return jsonify({"status": "deleted", "id": skill["id"]})


@customize_bp.get("/skills/<skill_id>/export")
@require_user
def export_skill(user, skill_id):
    skill = owned_skill(skill_id, user.id)
    if not skill:
        return bad_request("skill not found", 404)
    data = skill_service.export_skill(skill, store.list_skill_files(skill["id"], user.id))
    return send_file(io.BytesIO(data), mimetype="application/zip", as_attachment=True, download_name=f'{skill["name"]}.zip')
