import random

import pytest

from app.services.geo import distance_m
from scripts.simulate import CLUSTER_SPAN_S, offset_point, parse_args, plan


def test_offset_point_stays_within_distance():
    rng = random.Random(1)
    for _ in range(500):
        lat, lng = offset_point(42.6977, 23.3219, 200, rng)
        assert distance_m(42.6977, 23.3219, lat, lng) <= 200.5


def test_plan_sends_every_report_within_the_run():
    events, planned = plan(200, 120, random.Random(2))

    assert len(planned) == 200
    assert all(0 <= p.at <= 120 for p in planned)
    assert [p.at for p in planned] == sorted(p.at for p in planned)
    assert {p.event_id for p in planned} == {e.id for e in events}


def test_short_run_still_spreads_events():
    events, planned = plan(80, 30, random.Random(4))

    starts = sorted(min(p.at for p in planned if p.event_id == e.id) for e in events)
    assert starts[-1] - starts[0] > 10
    assert all(p.at <= 30 for p in planned)


def test_plan_keeps_each_cluster_short():
    _, planned = plan(300, 300, random.Random(3))

    times: dict[int, list[float]] = {}
    for p in planned:
        times.setdefault(p.event_id, []).append(p.at)
    assert all(max(t) - min(t) <= CLUSTER_SPAN_S for t in times.values())
    # Most events are reported by more than one citizen.
    assert sum(1 for t in times.values() if len(t) > 1) > len(times) / 2


def test_parse_args_defaults_and_checks():
    args = parse_args(["--citizens", "50", "--reports", "200"])
    assert args.url == "http://localhost:8000"

    with pytest.raises(SystemExit):
        parse_args(["--citizens", "1"])
