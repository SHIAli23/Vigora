/* Operator 112 panel: live stats, the incident queue by urgency, and the map with
   incidents and teams. */
(function () {
  "use strict";

  var STATS_EVERY_MS = 15000;
  var INCIDENTS_EVERY_MS = 30000; // waiting time raises the urgency, so reload now and then
  var OPEN_STATUSES = ["new", "assigned", "accepted", "on_scene"];
  var LEVEL_WORDS = { critical: "критичен", high: "висок", medium: "среден", low: "нисък" };
  var LEVEL_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

  var loginScreen = document.getElementById("login-screen");
  var panel = document.getElementById("panel");
  var connLabel = document.getElementById("conn");
  var resetDialog = document.getElementById("reset-dialog");
  var queueList = document.getElementById("queue-list");
  var queueCount = document.getElementById("queue-count");

  var socket = null;
  var statsTimer = null;
  var incidentsTimer = null;
  var statsRequest = 0; // only the newest answer may draw the stats
  var incidentsRequest = 0; // the same for the incident list
  var map = null;
  var teamLayer = null;
  var incidentLayer = null;
  var teamMarkers = {}; // team id -> marker

  var incidents = new Map(); // incident id -> summary from the server
  var incidentMarkers = new Map(); // incident id -> marker
  var selectedId = null;
  var changedIds = new Set(); // tickets to highlight once on the next draw

  // ---------- Login ----------

  Vigora.setupLogin({ role: "operator", onSuccess: startPanel });

  document.getElementById("logout").addEventListener("click", function () {
    stopPanel();
    Vigora.logout();
    document.getElementById("login-form").reset();
    panel.classList.add("hidden");
    loginScreen.classList.remove("hidden");
  });

  function setConnection(online) {
    connLabel.classList.toggle("online", online);
    connLabel.classList.toggle("offline", !online);
    connLabel.textContent = online ? "На линия" : "Няма връзка";
  }

  // ---------- Stats ----------

  // Seconds as "45 с" or "3 мин"; "—" when there is nothing to measure yet.
  function formatWait(seconds) {
    if (seconds == null) return "—";
    if (seconds < 60) return seconds + " с";
    return Math.round(seconds / 60) + " мин";
  }

  function setStat(id, value) {
    var el = document.getElementById(id);
    var text = String(value);
    if (el.textContent !== text) {
      var first = el.textContent === "—";
      el.textContent = text;
      if (first) return;
      // A short flash, so a change is noticed without staring at the numbers.
      el.classList.remove("changed");
      void el.offsetWidth;
      el.classList.add("changed");
    }
  }

  async function loadStats() {
    var request = ++statsRequest;
    try {
      var stats = await Vigora.request("/api/stats");
      if (request !== statsRequest) return;
      setStat("stat-open", stats.open);
      setStat("stat-critical", stats.critical);
      setStat("stat-confirmed", stats.confirmed);
      setStat("stat-confirm-time", formatWait(stats.avg_seconds_to_confirmation));
      setStat("stat-teams", stats.teams_available + "/" + stats.teams_total);
      // "online" counts open connections per role, e.g. {"operator": 1, "citizen": 3}.
      setStat("stat-online", (stats.online && stats.online.citizen) || 0);
      document.getElementById("stat-critical-box").classList.toggle("alert", stats.critical > 0);
    } catch (e) {
      /* The next round tries again; the connection status shows the problem. */
    }
  }

  // ---------- Incident queue ----------

  // The highest urgency first; equal urgency: the one waiting longest first.
  function sortedIncidents() {
    return Array.from(incidents.values()).sort(function (a, b) {
      if (b.urgency !== a.urgency) return b.urgency - a.urgency;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    });
  }

  function confirmations(incident) {
    return (incident.reports_count - 1) + incident.witness_yes;
  }

  function pillsHtml(incident) {
    var pills = [];
    if (incident.confirmed) {
      pills.push('<span class="pill pill-green">Потвърден от ' + Vigora.escapeHtml(Vigora.people(confirmations(incident))) + "</span>");
    } else if (incident.witnesses_asked > 0) {
      pills.push('<span class="pill">Чака свидетели (' + incident.witnesses_asked + ")</span>");
    }
    if (incident.witness_no > 0) {
      pills.push('<span class="pill pill-red">Отхвърлен от ' + Vigora.escapeHtml(Vigora.people(incident.witness_no)) + "</span>");
    }
    if (incident.has_photo) pills.push('<span class="pill">Снимка</span>');
    if (incident.assigned_team) {
      pills.push('<span class="pill pill-blue">' + Vigora.escapeHtml(incident.status_label) + "</span>");
    }
    return pills.length ? '<span class="ticket-pills">' + pills.join("") + "</span>" : "";
  }

  function ticketHtml(incident) {
    var classes = ["ticket", "level-" + incident.level];
    if (incident.id === selectedId) classes.push("selected");
    if (changedIds.has(incident.id)) classes.push("changed");
    var affected = incident.people_affected > 0
      ? incident.people_affected + " засегнати"
      : "Брой засегнати не е посочен";
    var level = LEVEL_WORDS[incident.level] || incident.level;
    return (
      '<button type="button" class="' + classes.join(" ") + '" data-id="' + incident.id + '"' +
      ' aria-pressed="' + (incident.id === selectedId) + '"' +
      ' aria-label="' + Vigora.escapeHtml(incident.type_label + ", спешност " + Math.round(incident.urgency) + ", " + level) + '">' +
      '<span class="ticket-score"><b>' + Math.round(incident.urgency) + "</b><small>" + Vigora.escapeHtml(level) + "</small></span>" +
      '<span class="ticket-body">' +
      '<span class="ticket-top"><span class="ticket-type">' + Vigora.escapeHtml(incident.type_label) + "</span>" +
      '<span class="ticket-time">' + Vigora.escapeHtml(Vigora.timeAgo(incident.created_at)) + "</span></span>" +
      '<span class="ticket-people">' + Vigora.escapeHtml(affected) + "</span>" +
      pillsHtml(incident) +
      "</span></button>"
    );
  }

  function renderQueue() {
    var list = sortedIncidents();
    queueCount.textContent = list.length ? String(list.length) : "";
    if (!list.length) {
      queueList.innerHTML =
        '<div class="queue-empty"><p>Няма активни сигнали.</p>' +
        '<p class="hint">Новите ще се появят тук автоматично.</p></div>';
    } else {
      var scroll = queueList.scrollTop;
      queueList.innerHTML = list.map(ticketHtml).join("");
      queueList.scrollTop = scroll;
    }
    changedIds.clear();
    renderIncidentMarkers();
  }

  queueList.addEventListener("click", function (event) {
    var ticket = event.target.closest(".ticket");
    if (ticket) select(Number(ticket.dataset.id));
  });

  // ---------- Incident markers ----------

  function incidentTooltip(incident) {
    return (
      "<b>" + Vigora.escapeHtml(incident.type_label) + "</b><br>" +
      "Спешност " + Math.round(incident.urgency) + " · " + Vigora.escapeHtml(LEVEL_WORDS[incident.level] || incident.level)
    );
  }

  function renderIncidentMarkers() {
    if (!incidentLayer) return;
    // Remove the markers of incidents that are gone.
    incidentMarkers.forEach(function (marker, id) {
      if (!incidents.has(id)) {
        incidentLayer.removeLayer(marker);
        incidentMarkers.delete(id);
      }
    });
    incidents.forEach(function (incident, id) {
      var icon = Vigora.incidentIcon(incident.type, { level: incident.level, selected: id === selectedId });
      // Critical ones lie on top, then by urgency; the selected one above all.
      var z = LEVEL_ORDER[incident.level] * 1000 + Math.round(incident.urgency) + (id === selectedId ? 10000 : 0);
      var marker = incidentMarkers.get(id);
      if (!marker) {
        marker = L.marker([incident.lat, incident.lng], { icon: icon, zIndexOffset: z, keyboard: false });
        marker.bindTooltip("", { direction: "top", offset: [0, -16], className: "team-tip" });
        marker.on("click", function () { select(id); });
        marker.addTo(incidentLayer);
        incidentMarkers.set(id, marker);
      } else {
        marker.setLatLng([incident.lat, incident.lng]);
        marker.setIcon(icon);
        marker.setZIndexOffset(z);
      }
      marker.setTooltipContent(incidentTooltip(incident));
    });
  }

  // ---------- Selection ----------

  function select(id) {
    var incident = incidents.get(id);
    if (!incident) return;
    selectedId = id;
    renderQueue();
    var ticket = queueList.querySelector('.ticket[data-id="' + id + '"]');
    if (ticket) ticket.scrollIntoView({ block: "nearest" });
    if (map) map.panTo([incident.lat, incident.lng], { animate: true });
  }

  // ---------- Loading and live changes ----------

  async function loadIncidents() {
    var request = ++incidentsRequest;
    try {
      var list = await Vigora.request("/api/incidents");
      if (request !== incidentsRequest) return;
      incidents = new Map(list.map(function (i) { return [i.id, i]; }));
      if (selectedId !== null && !incidents.has(selectedId)) selectedId = null;
      renderQueue();
    } catch (e) {
      if (request === incidentsRequest) Vigora.toast(e.message, { error: true });
    }
  }

  // An incident from a live event: add or update it, or drop it once it is closed.
  function applyIncident(incident, isNew) {
    incidentsRequest++; // a list still loading is older than this event
    if (OPEN_STATUSES.indexOf(incident.status) === -1) {
      incidents.delete(incident.id);
      if (selectedId === incident.id) selectedId = null;
    } else {
      incidents.set(incident.id, incident);
      changedIds.add(incident.id);
    }
    renderQueue();
    if (isNew && incident.level === "critical") {
      Vigora.toast("Нов критичен сигнал: " + incident.type_label, { error: true, ms: 6000 });
    }
  }

  function clearIncidents() {
    incidentsRequest++;
    incidents = new Map();
    selectedId = null;
    changedIds.clear();
    renderQueue();
  }

  // ---------- Teams ----------

  function teamTooltip(team) {
    var free = team.status === "available";
    return (
      "<b>" + Vigora.escapeHtml(team.name) + "</b><br>" +
      '<span class="tip-status ' + (free ? "free" : "busy") + '">' + (free ? "свободен" : "зает") + "</span>"
    );
  }

  function showTeam(team) {
    var marker = teamMarkers[team.id];
    if (!marker) {
      marker = L.marker([team.lat, team.lng], { icon: Vigora.teamIcon(team), keyboard: false });
      marker.bindTooltip("", { direction: "top", offset: [0, -12], className: "team-tip" });
      marker.addTo(teamLayer);
      teamMarkers[team.id] = marker;
    }
    marker.setLatLng([team.lat, team.lng]);
    marker.setIcon(Vigora.teamIcon(team));
    marker.setTooltipContent(teamTooltip(team));
  }

  async function loadTeams() {
    try {
      var teams = await Vigora.request("/api/teams");
      teams.forEach(showTeam);
    } catch (e) {
      Vigora.toast(e.message, { error: true });
    }
  }

  // ---------- Map ----------

  function renderLegend(meta) {
    var items = meta.types.map(function (t) {
      return (
        '<span class="legend-item"><i class="legend-dot" style="--dot:' + Vigora.escapeHtml(t.color) + '"></i>' +
        Vigora.escapeHtml(t.label) + "</span>"
      );
    });
    items.push('<span class="legend-item"><i class="legend-team">М</i>Екип</span>');
    document.getElementById("legend").innerHTML = items.join("");
  }

  function ensureMap() {
    if (map) {
      requestAnimationFrame(function () { map.invalidateSize(); });
      return;
    }
    map = Vigora.makeMap(document.getElementById("map"), { zoom: 13 });
    teamLayer = L.layerGroup().addTo(map);
    incidentLayer = L.layerGroup().addTo(map);
  }

  // ---------- Demo reset ----------

  document.getElementById("reset-demo").addEventListener("click", function () {
    resetDialog.showModal();
  });

  // The form closes the dialog by itself (method="dialog"); the confirm button also resets.
  document.getElementById("reset-confirm").addEventListener("click", async function () {
    try {
      await Vigora.request("/api/demo/reset", { method: "POST" });
      Vigora.toast("Демото е нулирано.");
      clearIncidents();
      loadStats();
      loadTeams();
    } catch (e) {
      Vigora.toast(e.message, { error: true });
    }
  });

  // ---------- Live events ----------

  function onEvent(event, data) {
    if (event === "incident.created" || event === "incident.updated") {
      applyIncident(data, event === "incident.created");
      loadStats();
    } else if (event === "team.updated") {
      showTeam(data);
      loadStats();
    } else if (event === "demo.reset") {
      clearIncidents();
      loadStats();
      loadTeams();
    }
  }

  // After every (re)connect: pick up what happened while offline.
  function onOpen() {
    loadStats();
    loadTeams();
    loadIncidents();
  }

  // ---------- Start and stop ----------

  function startPanel() {
    loginScreen.classList.add("hidden");
    panel.classList.remove("hidden");
    setConnection(false);
    connLabel.textContent = "Свързване…";

    ensureMap();
    Vigora.loadMeta()
      .then(function (meta) {
        renderLegend(meta);
        renderQueue(); // the markers use the type colors
      })
      .catch(function () { /* the map works without it */ });
    loadTeams();
    loadStats();
    loadIncidents();
    statsTimer = setInterval(loadStats, STATS_EVERY_MS);
    incidentsTimer = setInterval(loadIncidents, INCIDENTS_EVERY_MS);
    socket = Vigora.connect({ onStatus: setConnection, onEvent: onEvent, onOpen: onOpen });
  }

  function stopPanel() {
    clearInterval(statsTimer);
    clearInterval(incidentsTimer);
    statsTimer = incidentsTimer = null;
    statsRequest++;
    if (socket) socket.close();
    socket = null;
    if (teamLayer) teamLayer.clearLayers();
    teamMarkers = {};
    clearIncidents();
    document.querySelectorAll(".stat dd").forEach(function (el) { el.textContent = "—"; });
    document.getElementById("stat-critical-box").classList.remove("alert");
  }

  // A login from earlier in this tab is reused; an account of another role is dropped.
  var session = Vigora.session;
  if (session && session.user && session.user.role === "operator") {
    startPanel();
  } else {
    if (session) Vigora.setSession(null);
    loginScreen.classList.remove("hidden");
  }
})();
