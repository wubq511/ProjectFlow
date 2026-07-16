import os

import pytest

from app.core.config import settings
from app.services.resource_service import delete_uploaded_file_if_safe


def test_delete_uploaded_file_resolves_basename_inside_upload_root(
    monkeypatch, tmp_path
):
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    target = upload_dir / "safe.txt"
    target.write_text("content", encoding="utf-8")
    monkeypatch.setattr(settings, "upload_dir", str(upload_dir))

    delete_uploaded_file_if_safe("safe.txt")

    assert not target.exists()


@pytest.mark.parametrize(
    "file_name",
    ["../outside.txt", "nested/file.txt", "/tmp/outside.txt", "..", "."],
)
def test_delete_uploaded_file_rejects_path_semantics(
    monkeypatch, tmp_path, file_name
):
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    monkeypatch.setattr(settings, "upload_dir", str(upload_dir))

    with pytest.raises(PermissionError):
        delete_uploaded_file_if_safe(file_name)


def test_delete_uploaded_file_rejects_symlink_escape(monkeypatch, tmp_path):
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("keep", encoding="utf-8")
    os.symlink(outside, upload_dir / "escape.txt")
    monkeypatch.setattr(settings, "upload_dir", str(upload_dir))

    with pytest.raises(PermissionError):
        delete_uploaded_file_if_safe("escape.txt")

    assert outside.exists()
