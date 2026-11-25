/* Operator 112 panel: live stats, the map with the teams, and (later) the incident queue. */
(function () {
  "use strict";

  var STATS_EVERY_MS = 15000;

  var loginScreen = document.getElementById("login-screen");
  var panel = document.getElementById("panel");
  var connLabel = document.getElementById("conn");
  var resetDialog = document.getElementById("reset-dialog");

  var socket = null;
  var statsTimer = null;
  var statsRequest = 0; // only the newest answer may draw the stats
  var map = null;
  var teamLayer = null;
  var teamMarkers = {}; // team id -> marker

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

  // ---------- Map ----------

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
  }

  // ---------- Demo reset ----------

  document.getElementById("reset-demo").addEventListener("click", function () {
    resetDialog.showModal();
  });

  resetDialog.addEventListener("close", async function () {
    if (resetDialog.returnValue !== "confirm") return;
    try {
      await Vigora.request("/api/demo/reset", { method: "POST" });
      Vigora.toast("Демото е нулирано.");
      loadStats();
      loadTeams();
    } catch (e) {
      Vigora.toast(e.message, { error: true });
    }
  });

  // ---------- Live events ----------

  function onEvent(event, data) {
    if (event === "team.updated") {
      showTeam(data);
      loadStats();
    } else if (event === "incident.created" || event === "incident.updated") {
      loadStats();
    } else if (event === "demo.reset") {
      loadStats();
      loadTeams();
    }
  }

  // ---------- Start and stop ----------

  function startPanel() {
    loginScreen.classList.add("hidden");
    panel.classList.remove("hidden");
    setConnection(false);
    connLabel.textContent = "Свързване…";

    ensureMap();
    Vigora.loadMeta().then(renderLegend).catch(function () { /* the map works without it */ });
    loadTeams();
    loadStats();
    statsTimer = setInterval(loadStats, STATS_EVERY_MS);
    socket = Vigora.connect({
      onStatus: setConnection,
      onEvent: onEvent,
      onOpen: function () {
        loadStats();
        loadTeams();
      },
    });
  }

  function stopPanel() {
    clearInterval(statsTimer);
    statsTimer = null;
    statsRequest++;
    if (socket) socket.close();
    socket = null;
    if (teamLayer) teamLayer.clearLayers();
    teamMarkers = {};
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
