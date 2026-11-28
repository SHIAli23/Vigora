"""Signals that a photo may not have been taken on the spot.

These are hints for the operator, never a verdict: metadata can be missing for honest reasons
(messaging apps strip it) and can be faked. Every signal comes with a reason in plain Bulgarian.
"""

import io
import struct
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from PIL import Image, ImageOps

from app.services.geo import distance_m

LEVEL_OK = "ok"
LEVEL_CHECK = "check"
LEVEL_WARNING = "warning"

# A photo counts as "taken today" if it is at most this old.
RECENT = timedelta(hours=24)
# A GPS point closer than this to the report counts as the same place.
SAME_PLACE_M = 500
# Two difference hashes this close (in different bits out of 64) are the same picture.
SAME_PHOTO_BITS = 5

# EXIF tag numbers.
TAG_MAKE = 0x010F
TAG_MODEL = 0x0110
TAG_SOFTWARE = 0x0131
TAG_EXIF_IFD = 0x8769
TAG_GPS_IFD = 0x8825
TAG_DATE_TAKEN = 0x9003  # DateTimeOriginal
TAG_DATE_OFFSET = 0x9011  # OffsetTimeOriginal, for example "+02:00"

# PNG text chunks written by image generators (Stable Diffusion web UIs, ComfyUI).
GENERATOR_PNG_KEYS = ("parameters", "prompt", "workflow")
# Words in the EXIF Software value that name an image generator.
GENERATOR_SOFTWARE = (
    "midjourney",
    "dall-e",
    "dall·e",
    "stable diffusion",
    "stablediffusion",
    "comfyui",
    "automatic1111",
    "invokeai",
    "novelai",
    "firefly",
    "leonardo.ai",
    "imagen",
)
# The IPTC "digital source type" for generated images. It also matches
# "compositeWithTrainedAlgorithmicMedia", since the search ignores case.
GENERATED_SOURCE_TYPE = b"trainedalgorithmicmedia"

REASON_GENERATED = "Има данни, че е генерирана от програма"
REASON_REUSED = "Същата снимка вече е изпращана"


@dataclass
class PhotoCheckResult:
    level: str
    reasons: list[str] = field(default_factory=list)
    phash: str = ""


@dataclass
class _Signals:
    """What the separate checks found, before it is turned into a level."""

    reasons: list[str] = field(default_factory=list)
    has_camera: bool = False
    is_recent: bool = False
    warning: bool = False


def check_photo(
    content: bytes,
    report_lat: float,
    report_lng: float,
    now: datetime,
    earlier_hashes: Iterable[str] = (),
) -> PhotoCheckResult:
    """Look for signs that a photo was not taken on the spot, now.

    `content` must be an image Pillow can open. `now` is UTC without tzinfo, like the database.
    `earlier_hashes` are the difference hashes of photos sent before.
    """
    image = Image.open(io.BytesIO(content))
    exif = image.getexif()
    signals = _Signals()

    _check_camera(exif, signals)
    _check_date_taken(exif, now, signals)
    _check_gps(exif, report_lat, report_lng, signals)
    if _has_generator_marker(image, exif, content):
        signals.reasons.append(REASON_GENERATED)
        signals.warning = True
    phash = difference_hash(image)
    if _is_reused(phash, earlier_hashes):
        signals.reasons.append(REASON_REUSED)
        signals.warning = True

    return PhotoCheckResult(level=_level(signals), reasons=signals.reasons, phash=phash)


def _level(signals: _Signals) -> str:
    """Any warning wins. "ok" needs camera data and a recent date; anything else needs a look."""
    if signals.warning:
        return LEVEL_WARNING
    if signals.has_camera and signals.is_recent:
        return LEVEL_OK
    return LEVEL_CHECK


def _clean(value) -> str:
    """An EXIF text value without padding, or "" if it is missing or not text."""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    if not isinstance(value, str):
        return ""
    return value.replace("\x00", "").strip()


def _check_camera(exif: Image.Exif, signals: _Signals) -> None:
    """Camera make and model. Downloaded pictures and screenshots usually have neither."""
    make = _clean(exif.get(TAG_MAKE))
    model = _clean(exif.get(TAG_MODEL))
    if not make and not model:
        signals.reasons.append("Няма данни от камера (може да е изтеглена или екранна снимка)")
        return
    # Many cameras repeat the make in the model ("Canon EOS R6"), so do not write it twice.
    name = model if make and model.lower().startswith(make.lower()) else f"{make} {model}".strip()
    signals.reasons.append(f"Направена с камера ({name})")
    signals.has_camera = True


def _date_taken(exif: Image.Exif) -> datetime | None:
    """When the photo was taken, in UTC without tzinfo, or None if unknown.

    Cameras store local time. When the time zone offset is also stored, it is used; otherwise the
    time is taken as it is, which is at most a few hours off.
    """
    details = exif.get_ifd(TAG_EXIF_IFD)
    text = _clean(details.get(TAG_DATE_TAKEN))
    try:
        taken = datetime.strptime(text, "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None
    offset = _clean(details.get(TAG_DATE_OFFSET))
    if len(offset) == 6 and offset[0] in "+-" and offset[3] == ":":
        try:
            minutes = int(offset[1:3]) * 60 + int(offset[4:6])
        except ValueError:
            return taken
        sign = 1 if offset[0] == "+" else -1
        taken -= timedelta(minutes=sign * minutes)
    return taken


def _days_text(days: int) -> str:
    return "1 ден" if days == 1 else f"{days} дни"


def _check_date_taken(exif: Image.Exif, now: datetime, signals: _Signals) -> None:
    """The date the photo was taken. An old photo of the same place says nothing about today."""
    taken = _date_taken(exif)
    if taken is None:
        return
    age = now - taken
    # A camera clock without a time zone can be a few hours ahead, so the window is both ways.
    if abs(age) <= RECENT:
        signals.reasons.append("Направена днес")
        signals.is_recent = True
    elif age > RECENT:
        signals.reasons.append(f"Направена преди {_days_text(age.days)}")
        signals.warning = True
    # A date more than a day in the future means a wrong clock: no reason, and not "recent".


def _gps_degrees(values, ref) -> float | None:
    """EXIF GPS (degrees, minutes, seconds) and "N"/"S"/"E"/"W" to signed decimal degrees."""
    try:
        degrees, minutes, seconds = (float(v) for v in values)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    result = degrees + minutes / 60 + seconds / 3600
    return -result if _clean(ref).upper() in ("S", "W") else result


def _km_text(meters: float) -> str:
    km = meters / 1000
    if km < 10:
        return f"{km:.1f}".replace(".", ",")
    return str(round(km))


def _check_gps(exif: Image.Exif, report_lat: float, report_lng: float, signals: _Signals) -> None:
    """The GPS point the phone stored, compared with where the report says the incident is."""
    gps = exif.get_ifd(TAG_GPS_IFD)
    lat = _gps_degrees(gps.get(2), gps.get(1))
    lng = _gps_degrees(gps.get(4), gps.get(3))
    if lat is None or lng is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return
    meters = distance_m(lat, lng, report_lat, report_lng)
    if meters < SAME_PLACE_M:
        signals.reasons.append("Мястото на снимката съвпада")
    else:
        signals.reasons.append(f"Снимката е направена на {_km_text(meters)} км от сигнала")
        signals.warning = True


def _metadata_bytes(content: bytes) -> bytes:
    """All metadata blocks of a JPEG, PNG or WebP file, without the picture data itself.

    This covers XMP, IPTC and C2PA (content credentials) manifests: in JPEG they are APP
    segments (C2PA uses APP11), in PNG separate chunks (C2PA uses "caBX"), in WebP RIFF chunks.
    Skipping the picture data keeps random compressed bytes from looking like a marker.
    """
    parts: list[bytes] = []
    if content.startswith(b"\xff\xd8"):
        pos = 2
        while pos + 4 <= len(content) and content[pos] == 0xFF:
            marker = content[pos + 1]
            if marker == 0xDA:  # start of the picture data
                break
            (length,) = struct.unpack(">H", content[pos + 2 : pos + 4])
            parts.append(content[pos + 4 : pos + 2 + length])
            pos += 2 + length
    elif content.startswith(b"\x89PNG"):
        pos = 8
        while pos + 8 <= len(content):
            length, kind = struct.unpack(">I4s", content[pos : pos + 8])
            if kind != b"IDAT":
                parts.append(content[pos + 8 : pos + 8 + length])
            pos += 12 + length
    elif content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        pos = 12
        while pos + 8 <= len(content):
            kind, length = struct.unpack("<4sI", content[pos : pos + 8])
            if kind not in (b"VP8 ", b"VP8L", b"ANMF"):
                parts.append(content[pos + 8 : pos + 8 + length])
            pos += 8 + length + (length & 1)
    return b"\n".join(parts)


def _has_generator_marker(image: Image.Image, exif: Image.Exif, content: bytes) -> bool:
    """Traces that image generators leave in the file.

    - XMP/IPTC or a C2PA manifest that names the source as "trainedAlgorithmicMedia" (made by a
      model) or "compositeWithTrainedAlgorithmicMedia" (partly made by one). A C2PA manifest on
      its own is not a marker: some cameras sign real photos with one too.
    - PNG text chunks where Stable Diffusion tools store the prompt and settings.
    - An EXIF Software value that names a generator.
    """
    if GENERATED_SOURCE_TYPE in _metadata_bytes(content).lower():
        return True
    if image.format == "PNG" and any(key in image.info for key in GENERATOR_PNG_KEYS):
        return True
    software = _clean(exif.get(TAG_SOFTWARE)).lower()
    return any(name in software for name in GENERATOR_SOFTWARE)


def difference_hash(image: Image.Image) -> str:
    """A 64-bit perceptual hash, as 16 hex digits.

    The picture is turned upright, made gray and shrunk to 9x8; each bit says whether a pixel is
    brighter than its right neighbour. Resizing, recompressing or small edits keep most bits.
    """
    small = ImageOps.exif_transpose(image).convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = small.tobytes()  # one byte per pixel, row by row
    bits = 0
    for row in range(8):
        for col in range(8):
            left = pixels[row * 9 + col]
            right = pixels[row * 9 + col + 1]
            bits = (bits << 1) | (left > right)
    return f"{bits:016x}"


def hamming_distance(first: str, second: str) -> int:
    """How many of the 64 bits differ between two hashes."""
    return bin(int(first, 16) ^ int(second, 16)).count("1")


def _is_reused(phash: str, earlier_hashes: Iterable[str]) -> bool:
    """True if a photo sent before looks the same (a photo from another incident, sent again)."""
    return any(
        earlier and hamming_distance(phash, earlier) <= SAME_PHOTO_BITS
        for earlier in earlier_hashes
    )
