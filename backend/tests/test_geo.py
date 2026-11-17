import pytest

from app.services.geo import approximate, distance_m, is_valid_point


def test_same_point_is_zero():
    assert distance_m(42.6955, 23.3290, 42.6955, 23.3290) == 0


def test_one_degree_of_latitude():
    assert distance_m(42.0, 23.0, 43.0, 23.0) == pytest.approx(111195, abs=1)


def test_approximate_rounds_to_three_decimals():
    assert approximate(42.69554, 23.32896) == (42.696, 23.329)


@pytest.mark.parametrize(
    ("lat", "lng"),
    [(42.6955, 23.3290), (90, 180), (-90, -180), (0, 0)],
)
def test_valid_points(lat, lng):
    assert is_valid_point(lat, lng)


@pytest.mark.parametrize(
    ("lat", "lng"),
    [(90.1, 0), (-90.1, 0), (0, 180.1), (0, -180.1), (200, 300)],
)
def test_invalid_points_are_rejected(lat, lng):
    assert not is_valid_point(lat, lng)
