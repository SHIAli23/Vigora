"""Safe photo uploads. The file type is decided by its content, never by its name."""

import uuid

from fastapi import HTTPException, UploadFile, status

from app.config import settings

JPEG_SIGNATURE = b"\xff\xd8\xff"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def detect_extension(head: bytes) -> str | None:
    """Return ".jpg", ".png" or ".webp" from the first bytes of a file, or None for anything else."""
    if head.startswith(JPEG_SIGNATURE):
        return ".jpg"
    if head.startswith(PNG_SIGNATURE):
        return ".png"
    if head[0:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


async def save_photo(upload: UploadFile | None) -> str | None:
    """Check and save an uploaded photo. Returns the saved file name, or None if there is no file."""
    if upload is None or not upload.filename:
        return None

    max_bytes = settings.max_photo_mb * 1024 * 1024
    # Read one byte more than allowed, to know if the file is too big without reading all of it.
    content = await upload.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Снимката е над {settings.max_photo_mb} MB",
        )

    extension = detect_extension(content[:12])
    if extension is None:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Позволени са само JPG, PNG и WebP снимки",
        )

    # A random name, so the uploaded file name never reaches the file system.
    name = f"{uuid.uuid4().hex}{extension}"
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    (settings.upload_dir / name).write_bytes(content)
    return name
