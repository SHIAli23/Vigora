"""Load simulator: virtual citizens send reports in clusters and answer witness questions.

Run from the backend folder while the server is running:

    python -m scripts.simulate --citizens 50 --reports 200 --url http://localhost:8000

What it does:
- logs in as the demo operator (to read the stats at the end),
- registers N virtual citizens (sim-<run>-<n>) and connects each one over WebSocket,
  sharing a location near one of 5 hotspots in Sofia,
- creates events (a type and a point near a hotspot) and lets several citizens report the
  same event within a short time, spread over the run,
- keeps every citizen under the server's limit of 5 reports per 10 minutes,
- answers witness questions after 1-5 s: 80% yes, 10% no, 10% unsure.
"""

import argparse
import asyncio
import json
import math
import random
import secrets
import time
from collections import Counter, deque
from dataclasses import dataclass, field

import httpx
import websockets

PASSWORD = "simulate123"

# Must match the server: settings.report_limit_count per settings.report_limit_minutes.
RATE_LIMIT_COUNT = 5
RATE_LIMIT_WINDOW_S = 10 * 60

# A shared location is forgotten by the server after 10 minutes, so it is sent again.
LOCATION_REFRESH_S = 60

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
    incidents: set = field(default_factory=set)
    errors: Counter = field(default_factory=Counter)


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

    # ----- Setup -----

    async def login_operator(self) -> None:
        response = await self.client.post(
            "/api/auth/login", json={"username": "operator", "password": "operator123"}
        )
        response.raise_for_status()
        self.operator_token = response.json()["access_token"]

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

    # ----- WebSocket: location and witness questions -----

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
            self.stats.incidents.add(body["incident_id"])
        elif response.status_code == 429:
            self.stats.counts["rate_limited"] += 1
        else:
            self.stats.errors[f"report: HTTP {response.status_code}"] += 1

    # ----- Run -----

    async def run(self) -> None:
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

            # Let the last reports and witness answers (up to 5 s) finish.
            await asyncio.sleep(6)
            self.stopping.set()
            if self.tasks:
                await asyncio.wait(set(self.tasks), timeout=15)

            await self.summary(events)

    def progress(self, sent: int, total: int) -> None:
        c = self.stats.counts
        self.log(
            f"reports {sent}/{total} sent, {c['reports_ok']} accepted "
            f"({c['new_incidents']} new, {c['merged']} merged), "
            f"questions {c['questions']}, answers {sum(self.stats.answers.values())}"
        )

    async def summary(self, events: list[Event]) -> None:
        c = self.stats.counts
        answers = self.stats.answers
        latencies = sorted(self.stats.latencies)

        print()
        print("Summary")
        print("-------")
        print(f"Run:              sim-{self.run_id}, {time.monotonic() - self.started:.0f} s")
        print(f"Citizens:         {len(self.citizens)} registered, {c['connected']} connected")
        print(f"Events planned:   {len(events)}")
        print(
            f"Reports:          {c['reports_ok']} accepted, {c['rate_limited']} rate limited, "
            f"{sum(v for k, v in self.stats.errors.items() if k.startswith('report'))} failed"
        )
        print(
            f"Incidents:        {c['new_incidents']} new, {c['merged']} reports merged "
            f"into existing ones, {len(self.stats.incidents)} distinct"
        )
        print(f"Witnesses asked:  {c['witnesses_asked']} (questions received: {c['questions']})")
        print(
            f"Witness answers:  {answers['yes']} yes, {answers['no']} no, {answers['unsure']} unsure"
        )
        if c["answers_refused"]:
            print(
                f"                  {c['answers_refused']} refused: the witness had also "
                "reported the incident (counted once)"
            )
        if latencies:
            p95 = latencies[min(int(len(latencies) * 0.95), len(latencies) - 1)]
            print(
                f"Report time:      avg {sum(latencies) / len(latencies) * 1000:.0f} ms, "
                f"p95 {p95 * 1000:.0f} ms"
            )
        if self.stats.errors:
            print("Errors:           " + ", ".join(f"{k} x{v}" for k, v in self.stats.errors.items()))

        try:
            response = await self.client.get(
                "/api/stats", headers={"Authorization": f"Bearer {self.operator_token}"}
            )
            response.raise_for_status()
            stats = response.json()
            confirm = stats.get("avg_seconds_to_confirmation")
            print(
                f"Server (24 h):    {stats['open']} open, {stats['critical']} critical, "
                f"{stats['confirmed']} confirmed, avg to confirmation "
                f"{'-' if confirm is None else f'{confirm} s'}"
            )
        except (httpx.HTTPError, KeyError) as error:
            print(f"Server stats not available: {error}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Vigora load simulator")
    parser.add_argument("--citizens", type=int, default=50, help="virtual citizens (default 50)")
    parser.add_argument("--reports", type=int, default=200, help="reports to send (default 200)")
    parser.add_argument("--url", default="http://localhost:8000", help="server address")
    parser.add_argument(
        "--duration", type=float, default=120, help="seconds to spread the reports over (default 120)"
    )
    parser.add_argument("--seed", type=int, default=None, help="random seed, for a repeatable run")
    args = parser.parse_args(argv)
    if args.citizens < 2:
        parser.error("--citizens must be at least 2")
    if args.reports < 1:
        parser.error("--reports must be at least 1")
    if args.duration <= 0:
        parser.error("--duration must be positive")
    return args


def main() -> None:
    args = parse_args()
    try:
        asyncio.run(Simulator(args).run())
    except httpx.HTTPStatusError as error:
        raise SystemExit(f"Server error: {error.response.status_code} {error.response.text}")
    except httpx.ConnectError:
        raise SystemExit(f"Cannot connect to {args.url}. Is the server running?")
    except KeyboardInterrupt:
        raise SystemExit("Stopped.")


if __name__ == "__main__":
    main()
