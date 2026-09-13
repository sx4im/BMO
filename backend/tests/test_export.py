"""Unit and integration tests for BMO's response export feature."""

from __future__ import annotations

import importlib
import time
import zipfile
import io
import jwt
import pytest

from app.export_service import (
    HeadingBlock,
    ListBlock,
    MathBlock,
    ParagraphBlock,
    TableBlock,
    export_canonical_markdown,
    export_docx,
    export_pdf,
    parse_markdown_to_blocks,
    sanitize_export_filename,
)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "test-jwt-secret")
    monkeypatch.setenv("SUPABASE_STORAGE_BUCKET", "bimo-attachments")
    monkeypatch.setenv("NVIDIA_API_KEY", "test-nvidia-key")
    monkeypatch.setenv("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct")
    monkeypatch.setenv("CORS_ORIGINS", "*")

    main = importlib.import_module("app.main")
    importlib.reload(main)
    app = main.create_app()
    app.testing = True
    with app.test_client() as c:
        yield c


def auth_header(user_id: str = "user-123") -> dict:
    claims = {
        "sub": user_id,
        "aud": "authenticated",
        "iss": "https://example.supabase.co/auth/v1",
        "exp": int(time.time()) + 3600,
        "email": "user@example.com",
    }
    token = jwt.encode(claims, "test-jwt-secret", algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


SAMPLE_MARKDOWN = """# Quantum Computing Overview

Quantum computing leverages quantum mechanics to solve complex problems.

Key principles include:
1. Superposition
2. Entanglement
3. Quantum Interference

### Code Sample
```python
def q_state():
    return "|0> + |1>"
```

### Mathematical Formulation
$$|\\psi\\rangle = \\alpha |0\\rangle + \\beta |1\\rangle$$

> Quantum supremacy represents the milestone where quantum processors outpace classical supercomputers.

| Concept | Classical | Quantum |
| --- | --- | --- |
| Unit | Bit (0 or 1) | Qubit (Superposition) |
| Speed | Linear | Exponential for specific algorithms |

Check the official docs at [BMO AI](https://bimo.ai).
"""


def test_export_preserves_currency_without_latex_math():
    """Sentences containing multiple currency values must not be rendered as LaTeX math."""
    from app.export_service import parse_inline_spans

    text = "The budget is between $50 and $100 total."
    spans = parse_inline_spans(text)
    math_spans = [s for s in spans if getattr(s, "math", False)]
    assert len(math_spans) == 0
    full_text = "".join(s.text for s in spans)
    assert "$50 and $100" in full_text


def test_unauthorized_export_request(client):
    res = client.post("/export", json={"markdown": "hello", "format": "md"})
    assert res.status_code == 401


def test_invalid_jwt_export_request(client):
    res = client.post(
        "/export",
        headers={"Authorization": "Bearer invalid-jwt-token"},
        json={"markdown": "hello", "format": "md"},
    )
    assert res.status_code == 401


def test_unsupported_format(client):
    res = client.post(
        "/export",
        headers=auth_header(),
        json={"markdown": "test content", "format": "exe"},
    )
    assert res.status_code == 422
    assert "Unsupported format" in res.get_json()["detail"]


def test_missing_or_empty_markdown(client):
    res = client.post(
        "/export",
        headers=auth_header(),
        json={"format": "pdf", "markdown": "   "},
    )
    assert res.status_code == 422
    assert "Markdown content is required" in res.get_json()["detail"]

    res2 = client.post(
        "/export",
        headers=auth_header(),
        json={"format": "pdf"},
    )
    assert res2.status_code == 422


def test_oversized_markdown(client):
    oversized = "a" * 2_000_001
    res = client.post(
        "/export",
        headers=auth_header(),
        json={"format": "md", "markdown": oversized},
    )
    assert res.status_code == 413
    assert "exceeds maximum export size" in res.get_json()["detail"]


def test_valid_markdown_export(client):
    res = client.post(
        "/export",
        headers=auth_header(),
        json={
            "title": "Quantum Notes",
            "format": "md",
            "markdown": SAMPLE_MARKDOWN,
        },
    )
    assert res.status_code == 200
    assert "text/markdown" in res.headers.get("Content-Type", "")
    assert 'filename="quantum-notes.md"' in res.headers.get("Content-Disposition", "")

    text = res.data.decode("utf-8")
    assert "Quantum Computing Overview" in text
    assert "Generated on" in text
    assert "Created with Bmo" in text


def test_valid_pdf_export(client):
    res = client.post(
        "/export",
        headers=auth_header(),
        json={
            "title": "Quantum Notes",
            "format": "pdf",
            "markdown": SAMPLE_MARKDOWN,
        },
    )
    assert res.status_code == 200
    assert res.headers.get("Content-Type") == "application/pdf"
    assert 'filename="quantum-notes.pdf"' in res.headers.get("Content-Disposition", "")
    assert res.data.startswith(b"%PDF-")
    assert len(res.data) > 1000


def test_valid_docx_export(client):
    res = client.post(
        "/export",
        headers=auth_header(),
        json={
            "title": "Quantum Notes",
            "format": "docx",
            "markdown": SAMPLE_MARKDOWN,
        },
    )
    assert res.status_code == 200
    assert "wordprocessingml.document" in res.headers.get("Content-Type", "")
    assert 'filename="quantum-notes.docx"' in res.headers.get("Content-Disposition", "")
    assert res.data.startswith(b"PK")

    # Verify that the response is a valid ZIP archive containing word/document.xml
    with zipfile.ZipFile(io.BytesIO(res.data)) as zf:
        namelist = zf.namelist()
        assert "word/document.xml" in namelist
        doc_xml = zf.read("word/document.xml").decode("utf-8")
        assert "Quantum Computing Overview" in doc_xml
        assert "Superposition" in doc_xml


def test_filename_sanitization():
    assert sanitize_export_filename("Photosynthesis: How Plants Make Food?", "pdf") == "photosynthesis-how-plants-make-food.pdf"
    assert sanitize_export_filename("../../../etc/passwd", "docx") == "etcpasswd.docx"
    assert sanitize_export_filename("   ", "md") == "bmo-ai-response.md"
    assert sanitize_export_filename("Title with -- multiple --- hyphens", "pdf") == "title-with-multiple-hyphens.pdf"
    assert sanitize_export_filename(None, "docx") == "bmo-ai-response.docx"


def test_markdown_parser_unit():
    md = """# H1 Title
## H2 Title
Paragraph with **bold**, *italic*, `code`, and [link](https://example.com).

- Item 1
- Item 2
  - Subitem 2a

1. First
2. Second

```javascript
console.log("hello");
```

$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$

| Col A | Col B |
| :--- | :---: |
| val1 | val2 |
"""
    blocks = parse_markdown_to_blocks(md)
    assert any(isinstance(b, HeadingBlock) and b.level == 1 for b in blocks)
    assert any(isinstance(b, HeadingBlock) and b.level == 2 for b in blocks)
    assert any(isinstance(b, ParagraphBlock) for b in blocks)
    assert any(isinstance(b, ListBlock) and not b.ordered for b in blocks)
    assert any(isinstance(b, ListBlock) and b.ordered for b in blocks)
    assert any(isinstance(b, MathBlock) for b in blocks)
    assert any(isinstance(b, TableBlock) for b in blocks)


def test_export_pdf_with_special_characters():
    special_md = """# XML & HTML Safety <test> "quotes" 'single'

Here is code with brackets:
```html
<div class="test">Hello & Goodbye</div>
```

Math with relations:
$$a < b \\text{ and } c > d$$

Table with XML characters:
| Tag | Description |
| --- | --- |
| `<script>` | Escaped & safe |
| `<style>` | Not executed |
"""
    pdf_bytes = export_pdf("Safety & Security", special_md)
    assert pdf_bytes.startswith(b"%PDF-")


def test_export_docx_with_special_characters():
    special_md = """# XML & HTML Safety <test> "quotes"

Paragraph with symbols & special characters: < > & " ' © ™

| Header <1> | Header & 2 |
| --- | --- |
| Cell <A> | Cell & B |
"""
    docx_bytes = export_docx("Safety & Security", special_md)
    assert docx_bytes.startswith(b"PK")
