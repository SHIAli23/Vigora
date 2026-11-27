"""Load simulator: virtual citizens send reports in clusters and answer witness questions,
and the run is measured.

Run from the backend folder while the server is running:

    python -m scripts.simulate --citizens 50 --reports 200 --url http://localhost:8000
    python -m scripts.simulate --demo --sweep          # 10, 50 and 100 citizens, clean data

What it does:
- logs in as the demo operator and listens on the operator's WebSocket,
- registers N virtual citizens (sim-<run>-<n>) and connects each one over WebSocket,
  sharing a location near one of 5 hotspots in Sofia,
- creates events (a type and a point near a hotspot) and lets several citizens report the
  same event within a short time, spread over the run,
- keeps every citizen under the server's limit of 5 reports per 10 minutes,
- answers witness questions after 1-5 s: 80% yes, 10% no, 10% unsure.

What it measures:
- report -> operator delivery: from sending a report until the operator's WebSocket gets
  the incident event that report caused (average, median, 95th percentile),
- first report -> first witness "yes" for each new incident,
- duplicate detection: real events against incidents created, correctly merged reports,
  wrongly split reports and real events wrongly joined to another incident.

Results are saved to docs/results/<date-time>.csv and printed as a Markdown table.
"""

import argparse
import asyncio
import csv
import json
import math
import random
import secrets
import time
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import httpx
import websockets

PASSWORD = "simulate123"

# Must match the server: settings.report_limit_count per settings.report_limit_minutes.
RATE_LIMIT_COUNT = 5
RATE_LIMIT_WINDOW_S = 10 * 60

# A shared location is forgotten by the server after 10 minutes, so it is sent again.
LOCATION_REFRESH_S = 60

SWEEP_CITIZENS = (10, 50, 100)
RESULTS_DIR = Path(__file__).resolve().parents[2] / "docs" / "results"

HOTSPOTS = [
    ("Център", 42.6977, 23.3219),
    ("Младост", 42.6510, 23.3790),
    ("Люлин", 42.7160, 23.2560),
    ("Студентски град", 42.6505, 23.3460),
    ("Надежда", 42.7330, 23.3030),
]
# Citizens are placed within this distance of their hotspot, events a bit closer to the
# center, so most events have someone nearby to ask.
CITIZEN_SPREAD_M = 350
EVENT_SPREAD_M = 200
# Reports about the same event are this close to it, well inside every merge radius.
REPORT_SPREAD_M = 40

TYPE_WEIGHTS = {
    "medical": 30,
    "accident": 20,
    "fire": 15,
    "violence": 15,
    "suspicious": 15,
    "other": 5,
}
DESCRIPTIONS = {
    "medical": ["Човек припадна на спирката.", "Възрастна жена падна и не може да стане.", ""],
    "accident": ["Две коли се удариха на кръстовището.", "Блъснат мотоциклетист.", ""],
    "fire": ["Гъст дим от прозорец на третия етаж.", "Гори контейнер до блока.", ""],
    "violence": ["Сбиване пред магазина.", "Грабнаха чанта на жена.", ""],
    "suspicious": ["Някой оглежда паркираните коли.", "Човек се опитва да отвори вход.", ""],
    "other": ["Паднало дърво на тротоара.", "Силна миризма на газ.", ""],
}
ANSWER_WEIGHTS = {"yes": 80, "no": 10, "unsure": 10}
# The server's reply when a witness has also reported the same incident.
ALREADY_REPORTED = "Вече сте подали сигнал за този инцидент"

# How the reports of one event are spread: the first report starts the event, the others
# follow within this many seconds.
CLUSTER_SPAN_S = 25
CLUSTER_SIZES = [1, 2, 3, 4, 5, 6]
CLUSTER_SIZE_WEIGHTS = [15, 20, 25, 20, 12, 8]


# ---------- Geometry and planning (pure, so they can be tested) ----------


def offset_point(lat: float, lng: float, max_m: float, rng: random.Random) -> tuple[float, float]:
    """A random point at most max_m meters from (lat, lng), spread evenly over the disc."""
    distance = max_m * math.sqrt(rng.random())
    angle = rng.uniform(0, 2 * math.pi)
    d_lat = distance * math.cos(angle) / 111_195
    d_lng = distance * math.sin(angle) / (111_195 * math.cos(math.radians(lat)))
    return lat + d_lat, lng + d_lng


@dataclass
class Event:
    id: int
    type: str
    hotspot: int
    lat: float
    lng: float


@dataclass(order=True)
class PlannedReport:
    at: float  # seconds after the start
    event_id: int = field(compare=False)


def plan(
    reports: int, duration_s: float, rng: random.Random
) -> tuple[list[Event], list[PlannedReport]]:
    """Split the reports into events of 1-6 reports each, spread over the run.

    Returns the events and the reports sorted by time.
    """
    events: list[Event] = []
    planned: list[PlannedReport] = []
    remaining = reports
    # Short runs get shorter clusters, so the events can still be spread over the run.
    span = min(CLUSTER_SPAN_S, duration_s * 0.3)
    # Events start in the first 85% of the run, so their clusters can finish in time.
    last_start = max(duration_s * 0.85 - span, 0)
    while remaining > 0:
        size = min(rng.choices(CLUSTER_SIZES, CLUSTER_SIZE_WEIGHTS)[0], remaining)
        remaining -= size
        hotspot = rng.randrange(len(HOTSPOTS))
        _, h_lat, h_lng = HOTSPOTS[hotspot]
        lat, lng = offset_point(h_lat, h_lng, EVENT_SPREAD_M, rng)
        event_type = rng.choices(list(TYPE_WEIGHTS), list(TYPE_WEIGHTS.values()))[0]
        event = Event(id=len(events), type=event_type, hotspot=hotspot, lat=lat, lng=lng)
        events.append(event)

        start = rng.uniform(0, last_start)
        offsets = [0.0] + sorted(rng.uniform(min(2, span), span) for _ in range(size - 1))
        planned.extend(PlannedReport(at=start + o, event_id=event.id) for o in offsets)
    planned.sort()
    return events, planned


# ---------- Measurements (pure, so they can be tested) ----------


@dataclass
class ReportRecord:
    """One report the server accepted."""

    event_id: int  # the real event the script meant
    incident_id: int  # where the server put it
    merged: bool
    sent_at: float  # monotonic time the report was sent


def percentile(values: list[float], p: float) -> float | None:
    """The p-th percentile (nearest rank), or None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(math.ceil(p / 100 * len(ordered)), 1)
    return ordered[rank - 1]


def describe(values: list[float]) -> dict[str, float | None]:
    """Average, median and 95th percentile."""
    return {
        "avg": sum(values) / len(values) if values else None,
        "median": percentile(values, 50),
        "p95": percentile(values, 95),
    }


def match_deliveries(
    records: list[ReportRecord], report_events: dict[int, list[float]]
) -> tuple[list[float], int]:
    """Pair each report with the operator event it caused. Returns (seconds, unmatched).

    report_events holds, per incident, the times the operator received an event caused by
    a new report. Per incident, reports are paired in the order they were sent with the
    first unused event that arrived after the report was sent.
    """
    sends: dict[int, list[float]] = defaultdict(list)
    for record in records:
        sends[record.incident_id].append(record.sent_at)

    delays: list[float] = []
    unmatched = 0
    for incident_id, times in sends.items():
        arrivals = sorted(report_events.get(incident_id, []))
        index = 0
        for sent_at in sorted(times):
            while index < len(arrivals) and arrivals[index] < sent_at:
                index += 1
            if index < len(arrivals):
                delays.append(arrivals[index] - sent_at)
                index += 1
            else:
                unmatched += 1
    return delays, unmatched


def time_to_first_yes(
    records: list[ReportRecord], first_yes: dict[int, float]
) -> list[float]:
    """Seconds from the first report of each new incident to its first witness "yes"."""
    created: dict[int, float] = {}
    for record in records:
        if not record.merged:
            created[record.incident_id] = min(
                record.sent_at, created.get(record.incident_id, record.sent_at)
            )
    return [first_yes[i] - t for i, t in created.items() if i in first_yes]


def dedup_quality(records: list[ReportRecord]) -> dict[str, float | int | None]:
    """Compare where the server put each report with the real event behind it.

    Each real event is anchored to the incident its first new-incident report created.
    An event with no such report was joined to another incident (two events became one).
    Every other report of the event is correctly merged if it went to the anchor incident,
    otherwise wrongly split.
    """
    ordered = sorted(records, key=lambda r: r.sent_at)
    by_event: dict[int, list[ReportRecord]] = defaultdict(list)
    for record in ordered:
        by_event[record.event_id].append(record)

    correctly_merged = wrongly_split = events_joined = 0
    for event_records in by_event.values():
        creators = [r for r in event_records if not r.merged]
        anchor = creators[0] if creators else event_records[0]
        if not creators:
            events_joined += 1
        for record in event_records:
            if record is anchor:
                continue
            if record.incident_id == anchor.incident_id:
                correctly_merged += 1
            else:
                wrongly_split += 1

    expected = len(ordered) - len(by_event)
    return {
        "events": len(by_event),
        "incidents_created": sum(1 for r in ordered if not r.merged),
        "expected_duplicates": expected,
        "correctly_merged": correctly_merged,
        "wrongly_split": wrongly_split,
        "events_joined": events_joined,
        "dedup_accuracy_pct": round(100 * correctly_merged / expected, 1) if expected else None,
    }


# ---------- Virtual citizens ----------


@dataclass
class Citizen:
    n: int
    username: str
    token: str = ""
    user_id: int = 0
    hotspot: int = 0
    lat: float = 0.0
    lng: float = 0.0
    sent: deque = field(default_factory=deque)  # monotonic times of sent reports
    reported_events: set = field(default_factory=set)

    def has_capacity(self, now: float) -> bool:
        while self.sent and self.sent[0] <= now - RATE_LIMIT_WINDOW_S:
            self.sent.popleft()
        return len(self.sent) < RATE_LIMIT_COUNT

    def free_at(self) -> float:
        """When this citizen can send the next report (monotonic time)."""
        return self.sent[0] + RATE_LIMIT_WINDOW_S if self.sent else 0.0


@dataclass
class Stats:
    counts: Counter = field(default_factory=Counter)
    answers: Counter = field(default_factory=Counter)
    latencies: list = field(default_factory=list)
    errors: Counter = field(default_factory=Counter)
    records: list = field(default_factory=list)  # ReportRecord for each accepted report
    # What the operator's WebSocket saw, as monotonic arrival times:
    report_events: dict = field(default_factory=lambda: defaultdict(list))
    first_yes: dict = field(default_factory=dict)
    last_report_at: dict = field(default_factory=dict)


class Simulator:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.base = args.url.rstrip("/")
        self.ws_base = "ws" + self.base[len("http"):]  # http -> ws, https -> wss
        self.rng = random.Random(args.seed)
        self.run_id = secrets.token_hex(3)
        self.stats = Stats()
        self.citizens: list[Citizen] = []
        self.client: httpx.AsyncClient
        self.operator_token = ""
        self.started = 0.0
        self.tasks: set[asyncio.Task] = set()
        self.stopping = asyncio.Event()

    def log(self, text: str) -> None:
        elapsed = time.monotonic() - self.started if self.started else 0.0
        print(f"[{elapsed:6.1f}s] {text}", flush=True)

    def spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def operator_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.operator_token}"}

    # ----- Setup -----

    async def login_operator(self) -> None:
        response = await self.client.post(
            "/api/auth/login", json={"username": "operator", "password": "operator123"}
        )
        response.raise_for_status()
        self.operator_token = response.json()["access_token"]

    async def reset_demo(self) -> None:
        response = await self.client.post("/api/demo/reset", headers=self.operator_headers())
        response.raise_for_status()

    async def register(self, citizen: Citizen, limit: asyncio.Semaphore) -> None:
        async with limit:
            response = await self.client.post(
                "/api/auth/register",
                json={
                    "username": citizen.username,
                    "password": PASSWORD,
                    "full_name": f"Виртуален гражданин {citizen.n}",
                },
            )
        response.raise_for_status()
        body = response.json()
        citizen.token = body["access_token"]
        citizen.user_id = body["user"]["id"]

    def place(self, citizen: Citizen) -> None:
        citizen.hotspot = citizen.n % len(HOTSPOTS)
        _, h_lat, h_lng = HOTSPOTS[citizen.hotspot]
        citizen.lat, citizen.lng = offset_point(h_lat, h_lng, CITIZEN_SPREAD_M, self.rng)

    # ----- Operator WebSocket: what reaches the operator's screen, and when -----

    async def operator_socket(self, connected: asyncio.Event) -> None:
        url = f"{self.ws_base}/ws?token={self.operator_token}"
        try:
            async with websockets.connect(url, open_timeout=15, max_size=None) as ws:
                connected.set()
                while not self.stopping.is_set():
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=1)
                    except asyncio.TimeoutError:
                        continue
                    arrived = time.monotonic()
                    message = json.loads(raw)
                    self.on_operator_event(message.get("event"), message.get("data") or {}, arrived)
        except Exception as error:  # noqa: BLE001 - counted, the run goes on without it
            self.stats.errors[f"operator websocket: {type(error).__name__}"] += 1
        finally:
            connected.set()

    def on_operator_event(self, event: str | None, data: dict, arrived: float) -> None:
        if event not in ("incident.created", "incident.updated"):
            return
        incident_id = data["id"]
        # A witness answer also sends incident.updated. Only a new report changes
        # last_report_at, so that is how an event caused by a report is recognized.
        last = data.get("last_report_at")
        if event == "incident.created" or last != self.stats.last_report_at.get(incident_id):
            self.stats.report_events[incident_id].append(arrived)
            self.stats.last_report_at[incident_id] = last
        if data.get("witness_yes", 0) > 0 and incident_id not in self.stats.first_yes:
            self.stats.first_yes[incident_id] = arrived

    # ----- Citizen WebSocket: location and witness questions -----

    async def citizen_socket(self, citizen: Citizen, connected: asyncio.Event) -> None:
        url = f"{self.ws_base}/ws?token={citizen.token}"
        location = json.dumps({"type": "location", "lat": citizen.lat, "lng": citizen.lng})
        try:
            async with websockets.connect(url, open_timeout=15) as ws:
                await ws.send(location)
                self.stats.counts["connected"] += 1
                connected.set()
                last_shared = time.monotonic()
                while not self.stopping.is_set():
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    except asyncio.TimeoutError:
                        raw = None
                    if time.monotonic() - last_shared > LOCATION_REFRESH_S:
                        await ws.send(location)
                        last_shared = time.monotonic()
                    if raw is None:
                        continue
                    message = json.loads(raw)
                    if message.get("event") == "witness.question":
                        self.stats.counts["questions"] += 1
                        self.spawn(self.answer(citizen, message["data"]))
        except Exception as error:  # noqa: BLE001 - a lost socket is counted, not fatal
            self.stats.errors[f"websocket: {type(error).__name__}"] += 1
        finally:
            connected.set()

    async def answer(self, citizen: Citizen, question: dict) -> None:
        await asyncio.sleep(self.rng.uniform(1, 5))
        answer = self.rng.choices(list(ANSWER_WEIGHTS), list(ANSWER_WEIGHTS.values()))[0]
        try:
            response = await self.client.post(
                f"/api/witness/{question['request_id']}",
                data={"answer": answer},
                headers={"Authorization": f"Bearer {citizen.token}"},
            )
        except httpx.HTTPError as error:
            self.stats.errors[f"answer: {type(error).__name__}"] += 1
            return
        if response.status_code == 200:
            self.stats.answers[answer] += 1
        elif response.status_code == 409 and response.json().get("detail") == ALREADY_REPORTED:
            # The witness also reported this incident in the meantime. Not an error:
            # the server counts one person once.
            self.stats.counts["answers_refused"] += 1
        else:
            self.stats.errors[f"answer: HTTP {response.status_code}"] += 1

    # ----- Reports -----

    async def pick_reporter(self, event: Event) -> Citizen:
        """A citizen under the rate limit who has not reported this event, nearby if possible."""
        while True:
            now = time.monotonic()
            free = [
                c for c in self.citizens
                if c.has_capacity(now) and event.id not in c.reported_events
            ]
            nearby = [c for c in free if c.hotspot == event.hotspot]
            if nearby or free:
                return self.rng.choice(nearby or free)
            # Everyone is at the limit: wait for the first citizen to be free again.
            wait = min(c.free_at() for c in self.citizens) - now
            self.stats.counts["waited_for_limit"] += 1
            self.log(f"all citizens at the rate limit, waiting {wait:.0f} s")
            await asyncio.sleep(max(wait, 0.5))

    async def send_report(self, citizen: Citizen, event: Event) -> None:
        lat, lng = offset_point(event.lat, event.lng, REPORT_SPREAD_M, self.rng)
        data = {
            "type": event.type,
            "lat": str(lat),
            "lng": str(lng),
            "description": self.rng.choice(DESCRIPTIONS[event.type]),
            "people_affected": str(self.rng.choice([0, 0, 1, 1, 2, 3])),
        }
        started = time.monotonic()
        try:
            response = await self.client.post(
                "/api/reports", data=data, headers={"Authorization": f"Bearer {citizen.token}"}
            )
        except httpx.HTTPError as error:
            self.stats.errors[f"report: {type(error).__name__}"] += 1
            return
        self.stats.latencies.append(time.monotonic() - started)

        if response.status_code == 201:
            body = response.json()
            self.stats.counts["reports_ok"] += 1
            self.stats.counts["merged" if body["merged"] else "new_incidents"] += 1
            self.stats.counts["witnesses_asked"] += body["witnesses_asked"]
            self.stats.records.append(
                ReportRecord(
                    event_id=event.id,
                    incident_id=body["incident_id"],
                    merged=body["merged"],
                    sent_at=started,
                )
            )
        elif response.status_code == 429:
            self.stats.counts["rate_limited"] += 1
        else:
            self.stats.errors[f"report: HTTP {response.status_code}"] += 1

    # ----- Run -----

    async def run(self) -> dict:
        args = self.args
        capacity = args.citizens * RATE_LIMIT_COUNT
        if args.reports > capacity:
            print(
                f"Note: {args.reports} reports from {args.citizens} citizens is more than "
                f"{capacity} per 10 minutes, so the run will wait for the rate limit."
            )

        limits = httpx.Limits(max_connections=50, max_keepalive_connections=50)
        async with httpx.AsyncClient(base_url=self.base, timeout=30, limits=limits) as client:
            self.client = client
            self.started = time.monotonic()

            await self.login_operator()
            self.log("logged in as operator")
            if args.demo:
                await self.reset_demo()
                self.log("demo data reset")

            operator_ready = asyncio.Event()
            self.spawn(self.operator_socket(operator_ready))
            await operator_ready.wait()

            self.citizens = [
                Citizen(n=n, username=f"sim-{self.run_id}-{n}") for n in range(1, args.citizens + 1)
            ]
            registering = asyncio.Semaphore(10)
            await asyncio.gather(*(self.register(c, registering) for c in self.citizens))
            self.log(f"registered {len(self.citizens)} citizens (sim-{self.run_id}-*)")

            ready = []
            for citizen in self.citizens:
                self.place(citizen)
                connected = asyncio.Event()
                ready.append(connected)
                self.spawn(self.citizen_socket(citizen, connected))
            await asyncio.gather(*(e.wait() for e in ready))
            self.log(f"{self.stats.counts['connected']} citizens connected and sharing location")

            events, planned = plan(args.reports, args.duration, self.rng)
            self.log(f"planned {len(events)} events, {len(planned)} reports over {args.duration:.0f} s")

            start = time.monotonic()
            step = max(len(planned) // 10, 1)
            for index, item in enumerate(planned, start=1):
                delay = start + item.at - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                event = events[item.event_id]
                citizen = await self.pick_reporter(event)
                citizen.sent.append(time.monotonic())
                citizen.reported_events.add(event.id)
                self.spawn(self.send_report(citizen, event))
                if index % step == 0 or index == len(planned):
                    self.progress(index, len(planned))

            # Let the last reports and witness answers (up to 5 s) finish and reach the operator.
            await asyncio.sleep(7)
            self.stopping.set()
            if self.tasks:
                await asyncio.wait(set(self.tasks), timeout=15)

            result = self.result(len(planned))
            await self.summary(result)
            return result

    def progress(self, sent: int, total: int) -> None:
        c = self.stats.counts
        self.log(
            f"reports {sent}/{total} sent, {c['reports_ok']} accepted "
            f"({c['new_incidents']} new, {c['merged']} merged), "
            f"questions {c['questions']}, answers {sum(self.stats.answers.values())}"
        )

    def result(self, reports_sent: int) -> dict:
        """All measurements of this run, as one row for the CSV file."""
        s = self.stats
        deliveries, unmatched = match_deliveries(s.records, s.report_events)
        delivery = describe([d * 1000 for d in deliveries])
        first_yes = describe(time_to_first_yes(s.records, s.first_yes))
        http = describe([t * 1000 for t in s.latencies])
        dedup = dedup_quality(s.records)

        def rounded(value: float | None, digits: int = 0) -> float | int | None:
            if value is None:
                return None
            return round(value, digits) if digits else round(value)

        return {
            "run": f"sim-{self.run_id}",
            "citizens": len(self.citizens),
            "citizens_connected": s.counts["connected"],
            "reports_sent": reports_sent,
            "reports_accepted": s.counts["reports_ok"],
            "rate_limited": s.counts["rate_limited"],
            **dedup,
            "delivery_avg_ms": rounded(delivery["avg"]),
            "delivery_median_ms": rounded(delivery["median"]),
            "delivery_p95_ms": rounded(delivery["p95"]),
            "deliveries_measured": len(deliveries),
            "deliveries_unmatched": unmatched,
            "first_yes_avg_s": rounded(first_yes["avg"], 1),
            "first_yes_median_s": rounded(first_yes["median"], 1),
            "incidents_with_yes": len(time_to_first_yes(s.records, s.first_yes)),
            "witnesses_asked": s.counts["witnesses_asked"],
            "answers_yes": s.answers["yes"],
            "answers_no": s.answers["no"],
            "answers_unsure": s.answers["unsure"],
            "answers_refused": s.counts["answers_refused"],
            "http_avg_ms": rounded(http["avg"]),
            "http_p95_ms": rounded(http["p95"]),
            "errors": sum(s.errors.values()),
            "duration_s": round(time.monotonic() - self.started),
        }

    async def summary(self, r: dict) -> None:
        def ms(value):
            return "-" if value is None else f"{value} ms"

        def sec(value):
            return "-" if value is None else f"{value} s"

        print()
        print(f"Summary of {r['run']} ({r['duration_s']} s)")
        print("-" * 40)
        print(f"Citizens:          {r['citizens']} registered, {r['citizens_connected']} connected")
        print(
            f"Reports:           {r['reports_accepted']} of {r['reports_sent']} accepted, "
            f"{r['rate_limited']} rate limited"
        )
        print(
            f"Duplicates:        {r['events']} real events -> {r['incidents_created']} incidents; "
            f"{r['correctly_merged']} of {r['expected_duplicates']} duplicates merged correctly"
            + (f" ({r['dedup_accuracy_pct']}%)" if r["dedup_accuracy_pct"] is not None else "")
        )
        print(
            f"                   {r['wrongly_split']} wrongly split, "
            f"{r['events_joined']} real events joined to another incident"
        )
        print(
            f"To the operator:   avg {ms(r['delivery_avg_ms'])}, median {ms(r['delivery_median_ms'])}, "
            f"p95 {ms(r['delivery_p95_ms'])} ({r['deliveries_measured']} reports"
            + (f", {r['deliveries_unmatched']} not matched" if r["deliveries_unmatched"] else "")
            + ")"
        )
        print(
            f"First witness yes: avg {sec(r['first_yes_avg_s'])}, median "
            f"{sec(r['first_yes_median_s'])} after the first report "
            f"({r['incidents_with_yes']} incidents; witnesses wait 1-5 s on purpose)"
        )
        print(
            f"Witness answers:   {r['answers_yes']} yes, {r['answers_no']} no, "
            f"{r['answers_unsure']} unsure, {r['answers_refused']} refused (also reported)"
        )
        print(f"HTTP report time:  avg {ms(r['http_avg_ms'])}, p95 {ms(r['http_p95_ms'])}")
        if self.stats.errors:
            print("Errors:            " + ", ".join(f"{k} x{v}" for k, v in self.stats.errors.items()))
        print()


# ---------- Results ----------


def save_csv(results: list[dict], folder: Path, now: datetime) -> Path:
    """Write one row per run to <folder>/<date-time>.csv and return the path."""
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{now.strftime('%Y-%m-%d_%H-%M-%S')}.csv"
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=list(results[0]))
        writer.writeheader()
        writer.writerows(results)
    return path


def markdown_table(results: list[dict]) -> str:
    """A table in Bulgarian, ready to paste into the presentation."""

    def ms(value):
        return "—" if value is None else f"{value} ms"

    header = (
        "| Граждани | Сигнали | Реални събития | Създадени инциденти | Правилно обединени "
        "| Грешно разделени | Доставка до оператора (ср. / медиана / p95) "
        "| До първо „да“ от свидетел (медиана) |"
    )
    lines = [header, "|" + "---|" * 8]
    for r in results:
        merged = f"{r['correctly_merged']} от {r['expected_duplicates']}"
        if r["dedup_accuracy_pct"] is not None:
            merged += f" ({r['dedup_accuracy_pct']:g}%)".replace(".", ",")
        first_yes = "—" if r["first_yes_median_s"] is None else f"{r['first_yes_median_s']:g} s".replace(".", ",")
        lines.append(
            f"| {r['citizens']} | {r['reports_accepted']} | {r['events']} | {r['incidents_created']} "
            f"| {merged} | {r['wrongly_split']} "
            f"| {ms(r['delivery_avg_ms'])} / {ms(r['delivery_median_ms'])} / {ms(r['delivery_p95_ms'])} "
            f"| {first_yes} |"
        )
    return "\n".join(lines)


# ---------- Command line ----------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Vigora load simulator")
    parser.add_argument("--citizens", type=int, default=50, help="virtual citizens (default 50)")
    parser.add_argument("--reports", type=int, default=200, help="reports to send (default 200)")
    parser.add_argument("--url", default="http://localhost:8000", help="server address")
    parser.add_argument(
        "--duration", type=float, default=120, help="seconds to spread the reports over (default 120)"
    )
    parser.add_argument("--seed", type=int, default=None, help="random seed, for a repeatable run")
    parser.add_argument(
        "--demo", action="store_true",
        help="reset the demo data first (POST /api/demo/reset); deletes all incidents",
    )
    parser.add_argument(
        "--sweep", action="store_true",
        help="run with 10, 50 and 100 citizens one after another, "
        "keeping the reports per citizen of --reports/--citizens",
    )
    parser.add_argument(
        "--out", type=Path, default=RESULTS_DIR, help="folder for the CSV file (default docs/results)"
    )
    args = parser.parse_args(argv)
    if args.citizens < 2:
        parser.error("--citizens must be at least 2")
    if args.reports < 1:
        parser.error("--reports must be at least 1")
    if args.duration <= 0:
        parser.error("--duration must be positive")
    return args


def run_plans(args: argparse.Namespace) -> list[argparse.Namespace]:
    """The runs to make: one, or three for --sweep with the same reports per citizen."""
    if not args.sweep:
        return [args]
    per_citizen = args.reports / args.citizens
    runs = []
    for index, citizens in enumerate(SWEEP_CITIZENS):
        run = argparse.Namespace(**vars(args))
        run.citizens = citizens
        run.reports = max(round(citizens * per_citizen), 1)
        run.seed = None if args.seed is None else args.seed + index
        runs.append(run)
    return runs


async def run_all(args: argparse.Namespace) -> list[dict]:
    runs = run_plans(args)
    if args.sweep and not args.demo:
        print(
            "Note: without --demo, incidents left open by one run can absorb the reports of "
            "the next, which lowers the duplicate numbers."
        )
    results = []
    for number, run in enumerate(runs, start=1):
        if len(runs) > 1:
            print(f"\n=== Run {number} of {len(runs)}: {run.citizens} citizens, {run.reports} reports ===")
        results.append(await Simulator(run).run())
    return results


def main() -> None:
    args = parse_args()
    try:
        results = asyncio.run(run_all(args))
    except httpx.HTTPStatusError as error:
        raise SystemExit(f"Server error: {error.response.status_code} {error.response.text}")
    except httpx.ConnectError:
        raise SystemExit(f"Cannot connect to {args.url}. Is the server running?")
    except KeyboardInterrupt:
        raise SystemExit("Stopped.")

    path = save_csv(results, args.out, datetime.now())
    print(f"Results saved to {path}")
    print()
    print(markdown_table(results))


if __name__ == "__main__":
    main()
