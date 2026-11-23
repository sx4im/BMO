"""Text attachments use the same upload/processing flow as office documents."""
import io
import time
from types import SimpleNamespace

import httpx
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


def test_attachment_recovers_from_storage_disconnect_with_one_object(monkeypatch):
    objects = {}
    uploaded = []
    signed = []

    def upload(*, path, file, file_options):
        uploaded.append(path)
        assert path.startswith("owner/")
        if path in objects:
            assert file_options["upsert"] == "true"
        objects[path] = file
        if len(uploaded) == 1:
            raise httpx.RemoteProtocolError("Server disconnected after accepting file")

    def sign(path, expires):
        signed.append(path)
        if len(signed) == 1:
            raise httpx.RemoteProtocolError("Server disconnected before signing")
        return {"signedURL": "https://example.invalid/signed"}

    bucket = SimpleNamespace(upload=upload, create_signed_url=sign)
    monkeypatch.setattr(store, "supabase", lambda: SimpleNamespace(
        storage=SimpleNamespace(from_=lambda name: bucket),
    ))
    monkeypatch.setattr(store.time, "sleep", lambda duration: None)
    attachment = store.upload_attachment_for_user(
        "owner", filename="card.png", file_bytes=b"card", content_type="image/png",
    )
    assert uploaded == signed == [attachment["path"]] * 2
    assert objects == {attachment["path"]: b"card"}
    assert attachment["url"] == "https://example.invalid/signed"
