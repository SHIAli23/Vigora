import asyncio
import io

import pytest
from fastapi import HTTPException, UploadFile

from app.config import settings
from app.services.photos import detect_extension, save_photo
from tests.test_photo_check import NOW, POINT, image_bytes

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 20
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 20


@pytest.mark.parametrize(
    ("content", "extension"),
    [(JPEG, ".jpg"), (PNG, ".png"), (WEBP, ".webp")],
)
def test_detect_real_images(content, extension):
    assert detect_extension(content) == extension


@pytest.mark.parametrize(
    "content",
    [b"<?php echo 'hi'; ?>", b"GIF89a" + b"\x00" * 10, b"RIFF\x00\x00\x00\x00WAVE", b""],
)
def test_detect_rejects_other_content(content):
    assert detect_extension(content) is None


def upload(content, filename="photo.jpg"):
    return UploadFile(file=io.BytesIO(content), filename=filename)


def save(file):
    return asyncio.run(save_photo(file, *POINT, NOW))


def test_save_photo_without_file():
    assert save(None) is None


def test_save_photo_saves_with_random_name():
    name, result = save(upload(image_bytes("PNG"), filename="../../evil.jpg"))

    assert name.endswith(".png")
    assert "evil" not in name
    assert (settings.upload_dir / name).exists()
    assert result.level == "check"


@pytest.mark.parametrize("content", [b"not an image at all", PNG, JPEG])
def test_save_photo_rejects_fake_image(content):
    # The last two start like real images but cannot be decoded.
    with pytest.raises(HTTPException) as error:
        save(upload(content, filename="photo.jpg"))

    assert error.value.status_code == 415


def test_save_photo_rejects_too_big():
    too_big = JPEG + b"\x00" * (settings.max_photo_mb * 1024 * 1024)

    with pytest.raises(HTTPException) as error:
        save(upload(too_big))

    assert error.value.status_code == 413
    assert error.value.detail == f"Снимката е над {settings.max_photo_mb} MB"
