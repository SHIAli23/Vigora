from tests.conftest import auth, login


def test_login_ok(client):
    response = client.post(
        "/api/auth/login", json={"username": "operator", "password": "operator123"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["user"]["username"] == "operator"
    assert body["user"]["role"] == "operator"


def test_login_wrong_password(client):
    response = client.post(
        "/api/auth/login", json={"username": "operator", "password": "wrong-password"}
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Грешно потребителско име или парола"


def test_register_creates_citizen(client):
    response = client.post(
        "/api/auth/register",
        json={"username": "newuser", "password": "secret123", "full_name": "Нов Потребител"},
    )

    assert response.status_code == 201
    user = response.json()["user"]
    assert user["role"] == "citizen"
    assert user["team_id"] is None

    me = client.get("/api/auth/me", headers=auth(response.json()["access_token"]))
    assert me.json()["username"] == "newuser"


def test_register_duplicate_username(client):
    response = client.post(
        "/api/auth/register",
        json={"username": "citizen1", "password": "secret123", "full_name": "Някой Друг"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Потребителското име е заето"


def test_me_with_token(client):
    response = client.get("/api/auth/me", headers=auth(login(client, "med1")))

    assert response.status_code == 200
    assert response.json()["role"] == "team"
    assert response.json()["team_id"] is not None


def test_me_without_token(client):
    response = client.get("/api/auth/me")

    assert response.status_code == 401
    assert response.json()["detail"] == "Невалиден или изтекъл вход"


def test_me_with_invalid_token(client):
    response = client.get("/api/auth/me", headers=auth("not-a-real-token"))

    assert response.status_code == 401
