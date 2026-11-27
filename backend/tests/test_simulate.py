import csv
import random
from datetime import datetime

import pytest

from app.services.geo import distance_m
from scripts.simulate import (
    CLUSTER_SPAN_S,
    ReportRecord,
    dedup_quality,
    markdown_table,
    match_deliveries,
    offset_point,
    parse_args,
    percentile,
    plan,
    run_plans,
    save_csv,
    time_to_first_yes,
)


def rec(event_id, incident_id, merged, sent_at):
    return ReportRecord(event_id=event_id, incident_id=incident_id, merged=merged, sent_at=sent_at)


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


# ---------- Measurements ----------


def test_percentile():
    values = list(range(1, 101))
    assert percentile(values, 50) == 50
    assert percentile(values, 95) == 95
    assert percentile([7], 95) == 7
    assert percentile([], 50) is None


def test_deliveries_are_paired_in_order_per_incident():
    records = [rec(0, 1, False, 10.0), rec(0, 1, True, 20.0), rec(1, 2, False, 15.0)]
    # Incident 1 got two report events, incident 2 one; the 5.0 is from an older report.
    events = {1: [10.05, 20.08], 2: [5.0, 15.02]}

    delays, unmatched = match_deliveries(records, events)

    assert sorted(round(d, 2) for d in delays) == [0.02, 0.05, 0.08]
    assert unmatched == 0


def test_missing_delivery_is_counted():
    delays, unmatched = match_deliveries([rec(0, 1, False, 10.0)], {})

    assert delays == []
    assert unmatched == 1


def test_time_to_first_yes_counts_from_the_first_report():
    records = [rec(0, 1, False, 10.0), rec(0, 1, True, 12.0), rec(1, 2, False, 30.0)]

    assert time_to_first_yes(records, {1: 13.5}) == [3.5]


def test_dedup_all_correct():
    records = [
        rec(0, 1, False, 1), rec(0, 1, True, 2), rec(0, 1, True, 3),
        rec(1, 2, False, 4), rec(1, 2, True, 5),
    ]

    result = dedup_quality(records)

    assert result["events"] == 2
    assert result["incidents_created"] == 2
    assert result["expected_duplicates"] == 3
    assert result["correctly_merged"] == 3
    assert result["wrongly_split"] == 0
    assert result["events_joined"] == 0
    assert result["dedup_accuracy_pct"] == 100.0


def test_dedup_wrongly_split_and_joined():
    records = [
        rec(0, 1, False, 1),
        rec(0, 5, False, 2),  # same event, but a second incident: split
        rec(1, 1, True, 3),  # another event joined incident 1
        rec(1, 1, True, 4),  # its second report follows it: merged with its own event
    ]

    result = dedup_quality(records)

    assert result["incidents_created"] == 2
    assert result["wrongly_split"] == 1
    assert result["events_joined"] == 1
    assert result["correctly_merged"] == 1
    assert result["dedup_accuracy_pct"] == 50.0


def test_dedup_creator_sent_second_is_still_the_anchor():
    # Two reports sent almost together; the server created the incident for the second one.
    result = dedup_quality([rec(0, 1, True, 1.00), rec(0, 1, False, 1.01)])

    assert result["correctly_merged"] == 1
    assert result["events_joined"] == 0


# ---------- Runs and output ----------


def test_sweep_keeps_reports_per_citizen():
    args = parse_args(["--citizens", "50", "--reports", "200", "--sweep", "--seed", "5"])

    runs = run_plans(args)

    assert [(r.citizens, r.reports) for r in runs] == [(10, 40), (50, 200), (100, 400)]
    assert [r.seed for r in runs] == [5, 6, 7]


def test_single_run_without_sweep():
    args = parse_args(["--citizens", "20", "--reports", "60"])

    assert [(r.citizens, r.reports) for r in run_plans(args)] == [(20, 60)]


def sample_result(**overrides):
    result = {
        "run": "sim-abc", "citizens": 10, "reports_accepted": 40, "events": 12,
        "incidents_created": 12, "expected_duplicates": 28, "correctly_merged": 27,
        "wrongly_split": 1, "events_joined": 0, "dedup_accuracy_pct": 96.4,
        "delivery_avg_ms": 31, "delivery_median_ms": 25, "delivery_p95_ms": 80,
        "first_yes_median_s": 3.2,
    }
    result.update(overrides)
    return result


def test_save_csv(tmp_path):
    path = save_csv([sample_result(), sample_result(citizens=50)], tmp_path, datetime(2026, 11, 27, 9, 5, 3))

    assert path.name == "2026-11-27_09-05-03.csv"
    with path.open(encoding="utf-8") as file:
        rows = list(csv.DictReader(file))
    assert [row["citizens"] for row in rows] == ["10", "50"]


def test_markdown_table():
    table = markdown_table([sample_result(), sample_result(first_yes_median_s=None, dedup_accuracy_pct=None)])
    lines = table.splitlines()

    assert len(lines) == 4
    assert lines[0].startswith("| Граждани |")
    assert "27 от 28 (96,4%)" in lines[2]
    assert "31 ms / 25 ms / 80 ms" in lines[2]
    assert "3,2 s" in lines[2]
    assert lines[3].endswith("| — |")
