import struct
import zlib

from tests.conftest import FAR, NEAR, POINT, auth, login, send_report


def tiny_png() -> bytes:
    """A real 1x1 PNG image."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    pixels = zlib.compress(b"\x00\xff\x00\x00")
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", pixels)
        + chunk(b"IEND", b"")
    )


def test_send_report(client):
    token = login(client, "citizen1")

    response = send_report(client, token, description="Човек е паднал", people_affected=1)

    assert response.status_code == 201
    body = response.json()
    assert body["merged"] is False
    assert body["witnesses_asked"] == 0
    assert body["status"] == "new"
    assert body["status_label"] == "Приет от 112"


def test_unknown_type(client):
    response = send_report(client, login(client, "citizen1"), type_="alien")

    assert response.status_code == 422
    assert response.json()["detail"] == "Непознат тип сигнал"


def test_invalid_location(client):
    response = send_report(client, login(client, "citizen1"), point=(123.0, 23.0))

    assert response.status_code == 422
    assert response.json()["detail"] == "Невалидно местоположение"


def test_operator_cannot_send(client):
    response = send_report(client, login(client, "operator"))

    assert response.status_code == 403


def test_two_citizens_close_together_are_merged(client):
    first = send_report(client, login(client, "citizen1")).json()
    second = send_report(client, login(client, "citizen2"), point=NEAR).json()

    assert second["merged"] is True
    assert second["incident_id"] == first["incident_id"]

    mine = client.get("/api/reports/mine", headers=auth(login(client, "citizen1"))).json()
    assert mine[0]["confirmations"] == 1


def test_far_away_is_a_new_incident(client):
    first = send_report(client, login(client, "citizen1")).json()
    far = send_report(client, login(client, "citizen2"), point=FAR).json()

    assert far["merged"] is False
    assert far["incident_id"] != first["incident_id"]


def test_other_type_is_a_new_incident(client):
    first = send_report(client, login(client, "citizen1")).json()
    fire = send_report(client, login(client, "citizen2"), type_="fire", point=NEAR).json()

    assert fire["merged"] is False
    assert fire["incident_id"] != first["incident_id"]


def test_same_citizen_twice_is_not_counted_again(client):
    token = login(client, "citizen1")
    send_report(client, token)
    send_report(client, token, point=NEAR)

    mine = client.get("/api/reports/mine", headers=auth(token)).json()
    assert len(mine) == 2
    assert mine[0]["incident_id"] == mine[1]["incident_id"]
    assert mine[0]["confirmations"] == 0


def test_sixth_report_in_a_row_is_limited(client):
    token = login(client, "citizen1")
    for _ in range(5):
        assert send_report(client, token).status_code == 201

    response = send_report(client, token)

    assert response.status_code == 429
    assert response.json()["detail"] == "Твърде много сигнали. Опитайте след малко."


def test_real_png_photo_is_accepted(client):
    response = send_report(
        client, login(client, "citizen1"), photo=("photo.png", tiny_png(), "image/png")
    )

    assert response.status_code == 201


def test_fake_photo_is_rejected(client):
    response = send_report(
        client, login(client, "citizen1"), photo=("photo.jpg", b"<script>x</script>", "image/jpeg")
    )

    assert response.status_code == 415


def test_mine_shows_status_and_description(client):
    token = login(client, "citizen1")
    send_report(client, token, description="Дим от прозорец", type_="fire")

    response = client.get("/api/reports/mine", headers=auth(token))

    assert response.status_code == 200
    report = response.json()[0]
    assert report["status_label"] == "Приет от 112"
    assert report["description"] == "Дим от прозорец"
    assert report["type_label"] == "Пожар"


def test_meta_is_public(client):
    response = client.get("/api/meta")

    assert response.status_code == 200
    body = response.json()
    assert len(body["types"]) == 6
    assert {"key": "police", "label": "Полиция"} in body["team_kinds"]
    assert {"key": "new", "label": "Приет от 112"} in body["statuses"]
