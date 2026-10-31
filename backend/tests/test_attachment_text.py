"""Text attachments use the same upload/processing flow as office documents."""
import io
import time

import jwt
import pytest

from app import document_processor, store


@pytest.mark.parametrize("extension,content", [
    ("txt", "A text document with café and 日本語."),
    ("md", "# Reference\n\nMarkdown content."),
    ("json", '{"topic": "attachments"}'),
])
def test_text_attachment_upload_and_extraction(client, monkeypatch, extension, content):
    captured = {}
    def upload(user_id, **kwargs):
        captured.update(kwargs)
        return {"path": f"{user_id}/file.{extension}", "filename": kwargs["filename"],
                "content_type": kwargs["content_type"], "url": "https://example.invalid/file"}
    monkeypatch.setattr(store, "upload_attachment_for_user", upload)
    token = jwt.encode({"sub": "text-user", "aud": "authenticated",
                        "iss": "https://example.supabase.co/auth/v1", "exp": int(time.time()) + 3600},
                       "test-jwt-secret", algorithm="HS256")
    response = client.post("/attachments", headers={"Authorization": f"Bearer {token}"},
                           data={"file": (io.BytesIO(content.encode()), f"file.{extension}")})
    assert response.status_code == 200
    parts = document_processor.process_attachment(response.get_json(), lambda path: captured["file_bytes"])
    assert any(content in part.get("text", "") for part in parts)


@pytest.mark.parametrize("extension", ["txt", "md", "json"])
@pytest.mark.parametrize("content", [b"\xff\xfe\x80", b"document\x00binary"])
def test_text_attachment_validation_rejects_binary_payloads(extension, content):
    from app.config import upload_magic_ok
    assert not upload_magic_ok(content, f"file.{extension}")
