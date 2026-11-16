from app.security import create_token, decode_token, hash_password, verify_password


def test_correct_password():
    stored = hash_password("tajna123")
    assert verify_password("tajna123", stored)


def test_wrong_password():
    stored = hash_password("tajna123")
    assert not verify_password("druga456", stored)


def test_malformed_hash():
    assert not verify_password("tajna123", "not-a-hash")


def test_same_password_gives_different_hashes():
    assert hash_password("tajna123") != hash_password("tajna123")


def test_token_round_trip():
    payload = decode_token(create_token(7, "operator"))
    assert payload is not None
    assert payload["sub"] == "7"
    assert payload["role"] == "operator"


def test_broken_token_returns_none():
    token = create_token(7, "operator")
    header, payload, signature = token.split(".")
    other_payload = create_token(8, "operator").split(".")[1]
    assert decode_token(f"{header}.{other_payload}.{signature}") is None
    assert decode_token("garbage") is None
