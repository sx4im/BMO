"""Document content and expiring image URL regressions through real routes."""
import copy
import io
import uuid
import zipfile
from types import SimpleNamespace

import pytest
from pptx import Presentation
from pptx.util import Inches

from app import document_processor, project_service, store
from .test_regressions import db, gateway, headers, conversation, message
from .test_customize import auth, stream


def presentation():
    prs = Presentation()
    for index in range(12):
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = f"Quarter {index + 1} revenue"
        if index == 0:
            table = slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(4), Inches(1)).table
            table.cell(0, 0).text = "Region"
            table.cell(1, 0).text = "North"
            table.cell(1, 1).text = "12345"
            slide.notes_slide.notes_text_frame.text = "Presenter note: explain the increase."
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


def test_pptx_project_reads_all_slides_tables_and_notes():
    data = presentation()
    parsed = project_service.validate_and_process_upload("results.pptx", data, 0)
    assert project_service.get_mime_type("results.pptx").endswith("presentationml.presentation")
    for expected in ("Quarter 12 revenue", "North | 12345", "Presenter note"):
        assert expected in parsed[2]
    parts = document_processor.process_attachment({"path": "owner/slides", "filename": "results.pptx"}, lambda _: data)
    assert "North | 12345" in parts[0]["text"]
    assert '<attachment_data filename="results.pptx">' in parts[0]["text"]


def test_pptx_rejects_invalid_or_oversized_archive(monkeypatch):
    with pytest.raises(ValueError, match="valid .pptx"):
        project_service.validate_and_process_upload("broken.pptx", b"not a presentation", 0)
    data = presentation()
    monkeypatch.setattr(zipfile.ZipFile, "infolist", lambda _: [SimpleNamespace(file_size=101 * 1024 * 1024)])
    with pytest.raises(ValueError, match="safe processing limit"):
        document_processor._extract_pptx(data)


def test_csv_upload_is_accepted_and_rows_reach_chat(gateway, headers, db, monkeypatch):
    data = b'\xef\xbb\xbfregion,revenue\nNorth,12345\nSouth,67890\n'
    monkeypatch.setattr(store, "upload_attachment_for_user", lambda user, **kw: {"path": f"{user}/csv", "filename": kw["filename"], "content_type": kw["content_type"], "url": "https://example.invalid/csv"})
    uploaded = gateway.post("/attachments", headers=headers, data={"file": (io.BytesIO(data), "revenues.csv", "text/csv")})
    assert uploaded.status_code == 200
    monkeypatch.setattr(store, "download_attachment", lambda path, user_id: data)
    captured = stream(monkeypatch)
    response = gateway.post("/chat", headers=headers, json={"message": "Compare the revenues", "attachments": [uploaded.json], "auto_search": False})
    assert response.status_code == 200
    response.get_data(as_text=True)
    assert "North,12345" in str(captured)
    assert "South,67890" in str(captured)
    assert "\ufeff" not in str(captured)
    for invalid in (b"\x00binary", b"\xff\xfe"):
        rejected = gateway.post("/attachments", headers=headers, data={"file": (io.BytesIO(invalid), "revenues.csv", "text/csv")})
        assert rejected.status_code == 422


def signing_bucket(db):
    calls = []
    def sign(paths, expires):
        calls.append((paths, expires))
        return [{"path": path, "signedURL": f"https://storage.invalid/fresh/{path}", "error": None} for path in paths]
    db.storage = SimpleNamespace(from_=lambda _: SimpleNamespace(create_signed_urls=sign))
    return calls


def test_history_renews_owned_images_without_persisting_urls(gateway, headers, db):
    calls = signing_bucket(db)
    db.rows["conversations"] = [conversation()]
    db.rows["messages"] = [message(0, attachments=[{"path": "owner/photo.png", "url": "https://storage.invalid/expired", "content_type": "image/png"}])]
    original = copy.deepcopy(db.rows["messages"])
    response = gateway.get("/conversations/chat/messages", headers=headers)
    assert response.status_code == 200
    assert response.json["messages"][0]["attachments"][0]["url"].endswith("/fresh/owner/photo.png")
    assert calls == [(["owner/photo.png"], 3600)]
    assert db.rows["messages"] == original
    assert gateway.get("/conversations/chat/messages", headers=auth("other")).status_code == 404
    assert len(calls) == 1


def test_signing_never_accepts_foreign_or_traversal_paths(db):
    calls = signing_bucket(db)
    attachments = [{"path": path, "url": "https://storage.invalid/secret"} for path in ("other/private.png", "owner/../other/private.png", "owner/ok.png")]
    refreshed = store.refresh_attachment_urls([{"attachments": attachments}], "owner")
    assert calls == [(["owner/ok.png"], 3600)]
    assert [a["url"] for a in refreshed[0]["attachments"]][:2] == [None, None]


def test_shared_images_refresh_with_the_share_owner(db, gateway):
    calls = signing_bucket(db)
    share_id = str(uuid.uuid4())
    db.rows["shared_conversations"] = [{"id": share_id, "user_id": "owner", "snapshot": [{"role": "user", "attachments": [{"path": "owner/shared.png", "url": "expired"}]}]}]
    response = gateway.get(f"/share/{share_id}")
    assert response.status_code == 200
    assert response.json["messages"][0]["attachments"][0]["url"].endswith("/fresh/owner/shared.png")
    assert "user_id" not in response.json
    assert calls == [(["owner/shared.png"], 3600)]


def test_storage_failure_keeps_history_readable(db):
    calls = []
    def unavailable(*args):
        calls.append(args)
        raise RuntimeError("Storage unavailable")
    db.storage = SimpleNamespace(from_=lambda _: SimpleNamespace(create_signed_urls=unavailable, create_signed_url=unavailable))
    result = store.refresh_attachment_urls([{"content": "Answer", "attachments": [{"path": "owner/image.png", "url": "old-url"}]}], "owner")
    assert len(calls) == 1
    assert result[0]["content"] == "Answer"
    assert result[0]["attachments"][0]["url"] == "old-url"


def test_a_missing_storage_object_does_not_block_other_image_refreshes(db):
    calls = []
    def batch(*args):
        calls.append('batch')
        raise TypeError('storage3 could not decode a null signedURL')
    def single(path, expires):
        calls.append(path)
        if path.endswith('missing.png'):
            raise RuntimeError('Object not found')
        return {'signedURL': 'https://storage.invalid/fresh/' + path}
    db.storage = SimpleNamespace(from_=lambda _: SimpleNamespace(create_signed_urls=batch, create_signed_url=single))
    result = store.refresh_attachment_urls([{'attachments': [
        {'path': 'owner/missing.png', 'url': 'old-missing'}, {'path': 'owner/photo.png', 'url': 'old-photo'},
    ]}], 'owner')
    assert result[0]['attachments'][1]['url'].endswith('/fresh/owner/photo.png')
    assert calls == ['batch', 'owner/missing.png', 'owner/photo.png']
