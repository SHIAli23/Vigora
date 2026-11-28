"""Safe photo uploads. The file type is decided by its content, never by its name.

Every photo is checked for signs that it was not taken on the spot (see photo_check), then saved
again without its metadata, so a citizen's GPS position and camera details are never stored.
"""

import io
import json
import uuid
from collections.abc import Iterable
from datetime import datetime

from fastapi import HTTPException, UploadFile, status
from PIL import Image, ImageOps
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.models import Incident, PhotoCheck
from app.services.photo_check import PhotoCheckResult, check_photo

JPEG_SIGNATURE = b"\xff\xd8\xff"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Bigger pictures are refused before they are decoded, so a small file cannot fill the memory.
MAX_PIXELS = 60_000_000

# Pillow format names for each extension.
FORMATS = {".jpg": "JPEG", ".png": "PNG", ".webp": "WEBP"}


def detect_extension(head: bytes) -> str | None:
    """Return ".jpg", ".png" or ".webp" from the first bytes of a file, or None for anything else."""
    if head.startswith(JPEG_SIGNATURE):
        return ".jpg"
    if head.startswith(PNG_SIGNATURE):
        return ".png"
    if head[0:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


def _not_an_image() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="Позволени са само JPG, PNG и WebP снимки",
    )


def strip_metadata(content: bytes, extension: str) -> bytes:
    """The same picture, encoded again without EXIF, XMP, text chunks or comments.

    The EXIF rotation is applied to the pixels first, so the photo still shows the right way up.
    Only the colour profile and PNG transparency are kept: they change how it looks, not who
    took it or where.
    """
    image = ImageOps.exif_transpose(Image.open(io.BytesIO(content)))
    keep = {key: image.info[key] for key in ("icc_profile", "transparency") if key in image.info}
    # Encoders copy some values (like a JPEG comment) from info, so nothing else may stay there.
    image.info = {}

    target = FORMATS[extension]
    if target == "JPEG" and image.mode not in ("RGB", "L", "CMYK"):
        image = image.convert("RGB")
        keep.pop("transparency", None)
    elif target == "WEBP" and image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.mode or "transparency" in keep else "RGB")
        keep.pop("transparency", None)

    options: dict = {key: value for key, value in keep.items() if value}
    if target in ("JPEG", "WEBP"):
        options["quality"] = 90
    output = io.BytesIO()
    image.save(output, format=target, **options)
    return output.getvalue()


def _check_and_clean(
    content: bytes,
    extension: str,
    lat: float,
    lng: float,
    now: datetime,
    earlier_hashes: list[str],
) -> tuple[PhotoCheckResult, bytes]:
    """Decode, check and strip the photo. Slow work, so it runs outside the event loop."""
    try:
        with Image.open(io.BytesIO(content)) as image:
            if image.format != FORMATS[extension] or image.width * image.height > MAX_PIXELS:
                raise _not_an_image()
            image.load()  # fails on a broken or cut-off file
        result = check_photo(content, lat, lng, now, earlier_hashes)
        return result, strip_metadata(content, extension)
    except HTTPException:
        raise
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
        raise _not_an_image() from error


async def save_photo(
    upload: UploadFile | None,
    lat: float,
    lng: float,
    now: datetime,
    earlier_hashes: Iterable[str] = (),
) -> tuple[str, PhotoCheckResult] | None:
    """Check and save an uploaded photo taken for the point (lat, lng).

    Returns (saved file name, check result), or None if there is no file. The caller stores the
    result with record_photo_check.
    """
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
        raise _not_an_image()

    result, clean = await run_in_threadpool(
        _check_and_clean, content, extension, lat, lng, now, list(earlier_hashes)
    )

    # A random name, so the uploaded file name never reaches the file system.
    name = f"{uuid.uuid4().hex}{extension}"
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    (settings.upload_dir / name).write_bytes(clean)
    return name, result


def known_hashes(db: Session) -> list[str]:
    """The hashes of every photo checked so far, to find a photo that is sent again."""
    return [phash for phash in db.scalars(select(PhotoCheck.phash)) if phash]


def record_photo_check(
    db: Session, name: str, result: PhotoCheckResult, now: datetime
) -> PhotoCheck:
    """Store the check result of a saved photo."""
    row = PhotoCheck(
        name=name,
        level=result.level,
        reasons=json.dumps(result.reasons, ensure_ascii=False),
        phash=result.phash,
        created_at=now,
    )
    db.add(row)
    return row


def incident_photo_checks(incident: Incident) -> list[PhotoCheck]:
    """The check results of all report and witness photos of an incident, oldest first.

    Photos saved before checks existed have no result and are left out.
    """
    checks = [report.photo_check for report in incident.reports]
    checks += [request.photo_check for request in incident.witness_requests]
    return sorted((c for c in checks if c is not None), key=lambda c: c.id or 0)


def photo_check_view(check: PhotoCheck) -> dict:
    """A check result as shown to the operator."""
    return {"name": check.name, "level": check.level, "reasons": json.loads(check.reasons)}
