"""Export routes for Bmo documents (Markdown, PDF, DOCX)."""

from __future__ import annotations

import logging
from typing import Optional

from flask import Blueprint, Response, jsonify, request


from ..auth import require_user
from ..export_service import (
    export_canonical_markdown,
    export_docx,
    export_pdf,
    sanitize_export_filename,
)

logger = logging.getLogger("bmo.routes.export")

export_bp = Blueprint("export_routes", __name__)

MAX_EXPORT_CHARS = 2_000_000

MIME_TYPES = {
    "md": "text/markdown",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}



@export_bp.post("/export")
@require_user
def export_document(user):
    """Export canonical assistant markdown to the requested format (.md, .pdf, .docx)."""
    payload = request.get_json(silent=True) or {}

    raw_format = payload.get("format")
    if not raw_format or not isinstance(raw_format, str):
        return jsonify({"detail": "Format is required and must be one of: md, pdf, docx"}), 422

    fmt = raw_format.strip().lower()
    if fmt not in MIME_TYPES:
        return jsonify({"detail": f"Unsupported format '{raw_format}'. Supported formats: md, pdf, docx"}), 422

    markdown_text = payload.get("markdown")
    if markdown_text is None or not isinstance(markdown_text, str) or not markdown_text.strip():
        return jsonify({"detail": "Markdown content is required and cannot be empty"}), 422

    if len(markdown_text) > MAX_EXPORT_CHARS:
        return jsonify({"detail": f"Content exceeds maximum export size ({MAX_EXPORT_CHARS:,} characters)"}), 413

    raw_title: Optional[str] = payload.get("title")
    if raw_title is not None and not isinstance(raw_title, str):
        return jsonify({"detail": "Title must be a string"}), 422

    safe_filename = sanitize_export_filename(raw_title, fmt)

    try:
        if fmt == "md":
            file_bytes = export_canonical_markdown(raw_title, markdown_text)
        elif fmt == "pdf":
            file_bytes = export_pdf(raw_title, markdown_text)
        elif fmt == "docx":
            file_bytes = export_docx(raw_title, markdown_text)
        else:
            return jsonify({"detail": f"Unsupported format '{fmt}'"}), 422
    except Exception as exc:  # noqa: BLE001
        logger.error("export_document_failed error_type=%s", type(exc).__name__)
        return jsonify({"detail": f"Failed to generate {fmt.upper()} document: {exc}"}), 500

    mime = MIME_TYPES[fmt]
    content_type = f"{mime}; charset=utf-8" if fmt == "md" else mime

    response = Response(
        file_bytes,
        mimetype=mime,
        content_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{safe_filename}"',
            "Content-Length": str(len(file_bytes)),
            "X-Content-Type-Options": "nosniff",
        },
    )
    return response

