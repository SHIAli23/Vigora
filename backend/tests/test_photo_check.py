"""Tests for the photo check: signals that a photo was not taken on the spot, and metadata removal."""

import asyncio
import io
import random
from datetime import datetime, timedelta

from fastapi import UploadFile
from PIL import Image, PngImagePlugin

from app.config import settings
from app.database import SessionLocal, utcnow
from app.models import PhotoCheck
from app.services.photo_check import (
    REASON_GENERATED,
    REASON_REUSED,
    TAG_DATE_TAKEN,
    TAG_EXIF_IFD,
    TAG_GPS_IFD,
    TAG_MAKE,
    TAG_MODEL,
    TAG_SOFTWARE,
    check_photo,
    hamming_distance,
)
from app.services.photos import save_photo
from tests.conftest import auth, login, send_report

NOW = datetime(2026, 6, 1, 12, 0)
# A point in central Sofia (same as conftest.POINT), and one in Plovdiv, about 132 km away.
POINT = (42.6955, 23.3290)
PLOVDIV = (42.1354, 24.7453)

NO_CAMERA = "Няма данни от камера (може да е изтеглена или екранна снимка)"

_seeds = iter(range(1000, 100_000))


def picture(seed=None, size=(64, 48)):
    """A noisy colour picture. Each seed gives a different perceptual hash."""
    rng = random.Random(next(_seeds) if seed is None else seed)
    small = Image.new("RGB", (8, 6))
    small.putdata([tuple(rng.randrange(256) for _ in range(3)) for _ in range(48)])
    return small.resize(size, Image.Resampling.BILINEAR)


def to_dms(value):
    """Decimal degrees to EXIF (degrees, minutes, seconds)."""
    degrees = int(value)
    minutes = int((value - degrees) * 60)
    seconds = round(((value - degrees) * 60 - minutes) * 60, 2)
    return (degrees, minutes, seconds)


def camera_exif(taken=None, gps=None, software=None, orientation=None):
    """EXIF as a phone camera would write it."""
    exif = Image.Exif()
    exif[TAG_MAKE] = "Apple"
    exif[TAG_MODEL] = "iPhone 15"
    if software:
        exif[TAG_SOFTWARE] = software
    if orientation:
        exif[0x0112] = orientation
    if taken:
        exif.get_ifd(TAG_EXIF_IFD)[TAG_DATE_TAKEN] = taken.strftime("%Y:%m:%d %H:%M:%S")
    if gps:
        lat, lng = gps
        exif.get_ifd(TAG_GPS_IFD).update(
            {1: "N", 2: to_dms(lat), 3: "E", 4: to_dms(lng)}
        )
    return exif


def image_bytes(format_="JPEG", exif=None, image=None, **options):
    image = image or picture()
    output = io.BytesIO()
    if exif is not None:
        options["exif"] = exif
    image.save(output, format=format_, **options)
    return output.getvalue()


def check(content, earlier=()):
    return check_photo(content, *POINT, NOW, earlier)


# Single signals


def test_camera_photo_taken_today_is_ok():
    result = check(image_bytes(exif=camera_exif(taken=NOW - timedelta(minutes=5))))

    assert result.level == "ok"
    assert result.reasons == ["Направена с камера (Apple iPhone 15)", "Направена днес"]
    assert len(result.phash) == 16


def test_jpeg_without_exif_needs_a_check():
    result = check(image_bytes())

    assert result.level == "check"
    assert result.reasons == [NO_CAMERA]


def test_camera_photo_without_date_needs_a_check():
    result = check(image_bytes(exif=camera_exif()))

    assert result.level == "check"
    assert result.reasons == ["Направена с камера (Apple iPhone 15)"]


def test_old_photo_is_a_warning():
    result = check(image_bytes(exif=camera_exif(taken=NOW - timedelta(days=3, hours=2))))

    assert result.level == "warning"
    assert "Направена преди 3 дни" in result.reasons


def test_photo_from_yesterday_uses_singular():
    result = check(image_bytes(exif=camera_exif(taken=NOW - timedelta(hours=30))))

    assert "Направена преди 1 ден" in result.reasons


def test_png_with_parameters_chunk_is_a_warning():
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", "a car crash, photorealistic, Steps: 30, Sampler: Euler a")

    result = check(image_bytes("PNG", pnginfo=info))

    assert result.level == "warning"
    assert REASON_GENERATED in result.reasons


def test_generator_in_software_is_a_warning():
    exif = camera_exif(taken=NOW, software="Midjourney v7")

    result = check(image_bytes(exif=exif))

    assert result.level == "warning"
    assert REASON_GENERATED in result.reasons


def test_generated_source_type_in_xmp_is_a_warning():
    xmp = (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description '
        b'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/'
        b'compositeWithTrainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta>'
    )

    result = check(image_bytes(xmp=xmp))

    assert result.level == "warning"
    assert REASON_GENERATED in result.reasons


def test_gps_near_the_report_matches():
    near = (POINT[0] + 0.001, POINT[1])  # about 110 m north
    result = check(image_bytes(exif=camera_exif(taken=NOW, gps=near)))

    assert result.level == "ok"
    assert "Мястото на снимката съвпада" in result.reasons


def test_gps_far_away_is_a_warning():
    result = check(image_bytes(exif=camera_exif(taken=NOW, gps=PLOVDIV)))

    assert result.level == "warning"
    assert "Снимката е направена на 132 км от сигнала" in result.reasons


def test_same_picture_sent_again_is_a_warning():
    first = check(image_bytes(image=picture(seed=7)))
    # The same picture, saved again smaller and at a lower quality.
    again = image_bytes(image=picture(seed=7, size=(48, 36)), quality=60)

    second = check(again, earlier=[first.phash])

    assert hamming_distance(first.phash, second.phash) <= 5
    assert second.level == "warning"
    assert REASON_REUSED in second.reasons


def test_different_pictures_are_not_reused():
    first = check(image_bytes())

    second = check(image_bytes(), earlier=[first.phash])

    assert REASON_REUSED not in second.reasons


# Saving


def test_saved_photo_has_no_metadata_and_keeps_orientation():
    # Orientation 6 means "turn 90 degrees clockwise to show it": a wide picture shown tall.
    exif = camera_exif(taken=NOW, gps=POINT, orientation=6)
    content = image_bytes(exif=exif, image=picture(size=(64, 32)), comment=b"secret")
    assert Image.open(io.BytesIO(content)).getexif()  # the upload has EXIF

    upload = UploadFile(file=io.BytesIO(content), filename="photo.jpg")
    name, result = asyncio.run(save_photo(upload, *POINT, NOW))

    assert result.level == "ok"
    saved = Image.open(settings.upload_dir / name)
    assert saved.size == (32, 64)
    assert len(saved.getexif()) == 0
    assert "exif" not in saved.info
    assert "comment" not in saved.info
    assert b"Apple" not in (settings.upload_dir / name).read_bytes()


# Through the API


def png_with_prompt():
    info = PngImagePlugin.PngInfo()
    info.add_text("prompt", '{"3": {"class_type": "KSampler"}}')
    return image_bytes("PNG", pnginfo=info)


def incident_detail(client, incident_id):
    token = login(client, "operator")
    return client.get(f"/api/incidents/{incident_id}", headers=auth(token)).json()


def test_same_photo_uploaded_twice(client):
    content = image_bytes(image=picture(seed=42))
    photo = ("photo.jpg", content, "image/jpeg")

    first = send_report(client, login(client, "citizen1"), photo=photo).json()
    second = send_report(client, login(client, "citizen2"), photo=photo).json()

    assert first["incident_id"] == second["incident_id"]
    checks = incident_detail(client, first["incident_id"])["photo_checks"]
    assert [c["level"] for c in checks] == ["check", "warning"]
    assert REASON_REUSED not in checks[0]["reasons"]
    assert REASON_REUSED in checks[1]["reasons"]
    with SessionLocal() as db:
        assert db.query(PhotoCheck).count() == 2


def test_report_photo_check_in_detail_and_urgency(client):
    content = image_bytes(exif=camera_exif(taken=utcnow(), gps=POINT))

    sent = send_report(
        client, login(client, "citizen1"), photo=("photo.jpg", content, "image/jpeg")
    ).json()

    detail = incident_detail(client, sent["incident_id"])
    [photo_check] = detail["photo_checks"]
    assert photo_check["name"] == detail["reports"][0]["photo"]
    assert photo_check["level"] == "ok"
    assert {"label": "Има снимка", "points": 5} in detail["urgency_breakdown"]


def test_only_suspicious_photos_give_no_points(client):
    sent = send_report(
        client, login(client, "citizen1"), photo=("photo.png", png_with_prompt(), "image/png")
    ).json()

    detail = incident_detail(client, sent["incident_id"])
    assert detail["photo_checks"][0]["level"] == "warning"
    labels = [part["label"] for part in detail["urgency_breakdown"]]
    assert "Има снимка" not in labels
    assert {"label": "Снимката е съмнителна", "points": 0} in detail["urgency_breakdown"]


def test_one_good_photo_is_enough_for_points(client):
    bad = ("photo.png", png_with_prompt(), "image/png")
    good = ("photo.jpg", image_bytes(), "image/jpeg")

    first = send_report(client, login(client, "citizen1"), photo=bad).json()
    send_report(client, login(client, "citizen2"), photo=good)

    detail = incident_detail(client, first["incident_id"])
    assert [c["level"] for c in detail["photo_checks"]] == ["warning", "check"]
    assert {"label": "Има снимка", "points": 5} in detail["urgency_breakdown"]


def test_witness_photo_is_compared_with_the_incident_point(client):
    from tests.test_witness_answers import ask_witness

    request_id, incident_id, token = ask_witness(client)
    content = image_bytes(exif=camera_exif(taken=utcnow(), gps=PLOVDIV))

    response = client.post(
        f"/api/witness/{request_id}",
        data={"answer": "yes"},
        files={"photo": ("photo.jpg", content, "image/jpeg")},
        headers=auth(token),
    )

    assert response.status_code == 200
    [photo_check] = incident_detail(client, incident_id)["photo_checks"]
    assert photo_check["level"] == "warning"
    assert "Снимката е направена на 132 км от сигнала" in photo_check["reasons"]
