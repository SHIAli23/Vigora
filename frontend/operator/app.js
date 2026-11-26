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
    openDetail(id);
  }

  // ---------- Detail ----------

  var detailBody = document.getElementById("detail-body");
  var detailEmpty = document.getElementById("detail-empty");
  var detailId = null; // stays after the incident closes, so the final state can be read
  var detail = null; // the last loaded detail
  var detailRequest = 0;
  var busy = false; // an action is running
  var photoUrls = new Map(); // photo name -> blob URL (the endpoint needs the login)

  function openDetail(id) {
    if (detailId !== id) {
      detail = null;
      detailBody.innerHTML = '<p class="hint detail-loading">Зареждане…</p>';
    }
    detailId = id;
    detailEmpty.classList.add("hidden");
    detailBody.classList.remove("hidden");
    detailBody.scrollTop = 0;
    loadDetail();
  }

  function closeDetail() {
    detailRequest++;
    detailId = null;
    detail = null;
    detailBody.innerHTML = "";
    detailBody.classList.add("hidden");
    detailEmpty.classList.remove("hidden");
  }

  async function loadDetail() {
    if (detailId === null) return;
    var request = ++detailRequest;
    var id = detailId;
    try {
      var data = await Vigora.request("/api/incidents/" + id);
      if (request !== detailRequest) return;
      detail = data;
      renderDetail();
    } catch (e) {
      if (request !== detailRequest) return;
      if (e.status === 404) {
        closeDetail(); // deleted, e.g. by a demo reset
      } else {
        detailBody.innerHTML = '<p class="error-text detail-loading">' + Vigora.escapeHtml(e.message) + "</p>";
      }
    }
  }

  function signed(points) {
    if (points < 0) return '<span class="minus">−' + Math.abs(points) + "</span>";
    return "+" + points;
  }

  function headerHtml(d) {
    var level = LEVEL_WORDS[d.level] || d.level;
    var status = Vigora.escapeHtml(d.status_label) +
      (d.assigned_team ? ": " + Vigora.escapeHtml(d.assigned_team.name) : "");
    return (
      '<header class="detail-head level-' + Vigora.escapeHtml(d.level) + '">' +
      '<span class="ticket-score detail-score"><b>' + Math.round(d.urgency) + "</b><small>" + Vigora.escapeHtml(level) + "</small></span>" +
      '<div class="detail-title"><h2>' + Vigora.escapeHtml(d.type_label) + "</h2>" +
      "<p>" + status + ". Получен в " + Vigora.clock(d.created_at) + ".</p></div>" +
      '<button type="button" class="detail-close" data-action="close" aria-label="Затвори детайлите">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
      "</button></header>"
    );
  }

  function breakdownHtml(d) {
    var rows = (d.urgency_breakdown || []).map(function (item) {
      return "<tr><td>" + Vigora.escapeHtml(item.label) + '</td><td class="num">' + signed(item.points) + "</td></tr>";
    });
    rows.push('<tr class="total"><td>Общо</td><td class="num">' + Math.round(d.urgency) + "</td></tr>");
    return (
      '<section class="detail-section"><h3>Защо е с тази спешност</h3>' +
      '<table class="breakdown"><tbody>' + rows.join("") + "</tbody></table></section>"
    );
  }

  function witnessesHtml(d) {
    var asked = d.witnesses_asked;
    var body;
    if (!asked) {
      body = '<p class="hint">Нямаше хора наблизо, споделили местоположение.</p>';
    } else {
      var waiting = Math.max(0, asked - d.witness_yes - d.witness_no - d.witness_unsure);
      var part = function (n, cls) {
        return n ? '<i class="' + cls + '" style="width:' + (n / asked) * 100 + '%"></i>' : "";
      };
      body =
        '<div class="witness-bar" role="img" aria-label="Отговори на свидетели">' +
        part(d.witness_yes, "yes") + part(d.witness_no, "no") + part(d.witness_unsure, "unsure") + part(waiting, "waiting") +
        "</div>" +
        '<p class="witness-counts"><span>Да: <b>' + d.witness_yes + "</b></span><span>Не: <b>" + d.witness_no +
        "</b></span><span>Не виждат: <b>" + d.witness_unsure + "</b></span><span>Чакат: <b>" + waiting + "</b></span></p>";
    }
    if (d.reports_count > 1) {
      var others = d.reports_count - 1;
      body += '<p class="witness-more">' +
        (others === 1 ? "Още 1 човек е подал" : "Още " + others + " души са подали") +
        " отделен сигнал за същото място.</p>";
    }
    return '<section class="detail-section"><h3>Свидетели наблизо</h3>' + body + "</section>";
  }

  function teamsHtml(d) {
    var canAssign = d.status === "new" || d.status === "assigned";
    var list = d.team_candidates || [];
    var body = list.length
      ? list.map(function (team, i) {
          return (
            '<li class="candidate' + (i === 0 ? " preferred" : "") + '">' +
            '<span class="candidate-main"><b>' + Vigora.escapeHtml(team.name) + "</b>" +
            (i === 0 ? '<span class="pill pill-orange">Препоръчан</span>' : "") +
            '<small>' + Vigora.escapeHtml(team.kind_label) + " · " + Vigora.escapeHtml(Vigora.formatDistance(team.distance_m)) +
            " · около " + team.eta_min + " мин</small></span>" +
            '<button type="button" class="btn btn-small ' + (i === 0 ? "btn-primary" : "btn-quiet") + '"' +
            ' data-action="assign" data-team="' + team.id + '"' + (canAssign && !busy ? "" : " disabled") + ">Изпрати</button></li>"
          );
        }).join("")
      : '<li class="hint">Няма свободен подходящ екип в момента.</li>';
    return '<section class="detail-section"><h3>Екипи</h3><ul class="candidates">' + body + "</ul></section>";
  }

  function reportsHtml(d) {
    var items = d.reports.map(function (r) {
      var affected = r.people_affected > 0 ? r.people_affected + " засегнати" : "Брой засегнати не е посочен";
      return (
        '<li class="report"><p class="report-text' + (r.description ? "" : " empty") + '">' +
        Vigora.escapeHtml(r.description || "Без описание") + "</p>" +
        '<p class="report-meta">' + Vigora.clock(r.created_at) + " · " + Vigora.escapeHtml(affected) +
        " · доверие на подателя: " + Math.round(r.reporter_trust) + "/100</p></li>"
      );
    });
    return (
      '<section class="detail-section"><h3>Сигнали от граждани (' + d.reports.length + ")</h3>" +
      '<ul class="reports">' + items.join("") + "</ul></section>"
    );
  }

  function photoNames(d) {
    var names = d.reports.map(function (r) { return r.photo; }).filter(Boolean);
    return names.concat(d.witness_photos || []);
  }

  function photosHtml(d) {
    var names = photoNames(d);
    if (!names.length) return "";
    var items = names.map(function (name) {
      var url = photoUrls.get(name);
      return (
        '<button type="button" class="photo" data-action="photo" data-name="' + Vigora.escapeHtml(name) + '" aria-label="Отвори снимката">' +
        (url ? '<img src="' + url + '" alt="">' : '<span class="photo-loading"></span>') +
        "</button>"
      );
    });
    return '<section class="detail-section"><h3>Снимки</h3><div class="photos">' + items.join("") + "</div></section>";
  }

  function actionsHtml() {
    return (
      '<section class="detail-section detail-actions">' +
      '<button type="button" class="btn btn-primary" data-action="resolve"' + (busy ? " disabled" : "") + ">Приключи</button>" +
      '<button type="button" class="btn btn-quiet btn-outline-danger" data-action="false"' + (busy ? " disabled" : "") + ">Фалшив сигнал</button>" +
      "</section>"
    );
  }

  function historyHtml(d) {
    var items = d.events.map(function (e) {
      return '<li><time>' + Vigora.clock(e.created_at) + "</time><span>" + Vigora.escapeHtml(e.text) + "</span></li>";
    });
    return '<section class="detail-section"><h3>История</h3><ol class="history">' + items.join("") + "</ol></section>";
  }

  function renderDetail() {
    if (!detail) return;
    var d = detail;
    var open = OPEN_STATUSES.indexOf(d.status) !== -1;
    var scroll = detailBody.scrollTop;
    detailBody.innerHTML =
      headerHtml(d) +
      breakdownHtml(d) +
      witnessesHtml(d) +
      (open ? teamsHtml(d) : "") +
      reportsHtml(d) +
      photosHtml(d) +
      (open ? actionsHtml() : "") +
      historyHtml(d);
    detailBody.scrollTop = scroll;
    loadPhotos(d);
  }

  // Photos need the login, so they are fetched with the token and shown as blob URLs.
  function loadPhotos(d) {
    photoNames(d).forEach(function (name) {
      if (photoUrls.has(name)) return;
      photoUrls.set(name, null); // loading
      var session = Vigora.session;
      fetch("/api/photos/" + encodeURIComponent(name), {
        headers: session ? { Authorization: "Bearer " + session.access_token } : {},
      })
        .then(function (response) {
          if (!response.ok) throw new Error("photo " + response.status);
          return response.blob();
        })
        .then(function (blob) {
          photoUrls.set(name, URL.createObjectURL(blob));
          var button = detailBody.querySelector('.photo[data-name="' + CSS.escape(name) + '"]');
          if (button) button.innerHTML = '<img src="' + photoUrls.get(name) + '" alt="">';
        })
        .catch(function () {
          photoUrls.delete(name); // try again on the next render
          var button = detailBody.querySelector('.photo[data-name="' + CSS.escape(name) + '"]');
          if (button) button.innerHTML = '<span class="photo-error">Няма снимка</span>';
        });
    });
  }

  function forgetPhotos() {
    photoUrls.forEach(function (url) { if (url) URL.revokeObjectURL(url); });
    photoUrls = new Map();
  }

  // ---------- Detail actions ----------

  async function runAction(path, body, doneText) {
    if (busy || detailId === null) return;
    busy = true;
    renderDetail();
    try {
      var incident = await Vigora.request("/api/incidents/" + detailId + path, { method: "POST", json: body || {} });
      Vigora.toast(doneText(incident));
      applyIncident(incident, false);
      loadStats();
    } catch (e) {
      Vigora.toast(e.message, { error: true });
    } finally {
      busy = false;
      loadDetail();
    }
  }

  var photoView = document.getElementById("photo-view");
  var falseDialog = document.getElementById("false-dialog");

  detailBody.addEventListener("click", function (event) {
    var button = event.target.closest("[data-action]");
    if (!button || button.disabled) return;
    var action = button.dataset.action;
    if (action === "close") {
      selectedId = null;
      renderQueue();
      closeDetail();
    } else if (action === "assign") {
      var teamId = Number(button.dataset.team);
      var team = (detail.team_candidates || []).filter(function (t) { return t.id === teamId; })[0];
      runAction("/assign", { team_id: teamId }, function () {
        return "Изпратен екип: " + (team ? team.name : "");
      });
    } else if (action === "resolve") {
      runAction("/resolve", null, function () { return "Сигналът е приключен."; });
    } else if (action === "false") {
      falseDialog.showModal();
    } else if (action === "photo") {
      var url = photoUrls.get(button.dataset.name);
      if (!url) return;
      document.getElementById("photo-view-img").src = url;
      photoView.showModal();
    }
  });

  document.getElementById("false-confirm").addEventListener("click", function () {
    runAction("/false", null, function () { return "Сигналът е отбелязан като фалшив."; });
  });

  // A click anywhere on the full-screen photo closes it.
  photoView.addEventListener("click", function () {
    photoView.close();
  });

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
    if (incident.id === detailId) loadDetail();
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
    closeDetail();
    forgetPhotos();
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
      loadDetail(); // the free teams to choose from may have changed
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
    loadDetail();
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
