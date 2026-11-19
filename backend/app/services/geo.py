"""Distances and coordinates."""

from math import asin, cos, radians, sin, sqrt

EARTH_RADIUS_M = 6_371_000


def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Distance in meters between two points, using the haversine formula."""
    phi1, phi2 = radians(lat1), radians(lat2)
    d_phi = radians(lat2 - lat1)
    d_lambda = radians(lng2 - lng1)
    h = sin(d_phi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * asin(sqrt(h))


def approximate(lat: float, lng: float) -> tuple[float, float]:
    """Round a point to 3 decimals (about 100 m), to keep a citizen's exact location private."""
    return round(lat, 3), round(lng, 3)


def is_valid_point(lat: float, lng: float) -> bool:
    """True if the latitude is within -90..90 and the longitude within -180..180."""
    return -90 <= lat <= 90 and -180 <= lng <= 180
