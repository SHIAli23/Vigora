/* Team app: the team's current task from 112 and one button for the next step. */
(function () {
  "use strict";

  // The one next step for each status: the button text and the status it sends.
  var NEXT_STEP = {
    assigned: { label: "Приемам задачата", status: "accepted" },
    accepted: { label: "Пристигнахме на място", status: "on_scene" },
    on_scene: { label: "Случаят е приключен", status: "resolved" },
  };
  var STEPS = [
    { status: "accepted", label: "Приета" },
    { status: "on_scene", label: "На място" },
    { status: "resolved", label: "Приключена" },
  ];
  var STEPS_DONE = { assigned: 0, accepted: 1, on_scene: 2, resolved: 3 };
  var LEVEL_WORDS = { critical: "критичен", high: "висок", medium: "среден", low: "нисък" };

  var loginScreen = document.getElementById("login-screen");
  var appScreen = document.getElementById("app");
  var connLabel = document.getElementById("conn");
  var loadingBox = document.getElementById("loading");
  var idleBox = document.getElementById("idle");
  var taskBox = document.getElementById("task");

  var socket = null;
  var map = null;
  var loadRequest = 0; // only the newest answer may draw the screen
  var lastTaskId; // undefined until the first load, so the first load does not vibrate
  var busy = false;

  // ---------- Login ----------

  Vigora.setupLogin({ role: "team", onSuccess: start });

  document.getElementById("logout").addEventListener("click", function () {
    stop();
    Vigora.logout();
    document.getElementById("login-form").reset();
    appScreen.classList.add("hidden");
    loginScreen.classList.remove("hidden");
  });

  function setConnection(online) {
    connLabel.classList.toggle("online", online);
    connLabel.classList.toggle("offline", !online);
    connLabel.textContent = online ? "На линия" : "Няма връзка";
  }

  // ---------- Loading ----------

  async function load() {
    var request = ++loadRequest;
    try {
      var data = await Vigora.request("/api/teams/me");
      if (request !== loadRequest) return;
      render(data);
    } catch (e) {
      if (request !== loadRequest) return;
      loadingBox.classList.add("hidden");
      Vigora.toast(e.message, { error: true });
    }
  }

  function render(data) {
    var team = data.team;
    document.getElementById("team-name").textContent = team.name + ", " + team.kind_label;
    loadingBox.classList.add("hidden");

    var task = data.task;
    var taskId = task ? task.id : null;
    if (lastTaskId !== undefined && taskId !== null && taskId !== lastTaskId) {
      // A new task while the app is open: a short buzz, on phones that support it.
      if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    }
    lastTaskId = taskId;

    if (!task) {
      removeMap();
      taskBox.classList.add("hidden");
      taskBox.innerHTML = "";
      idleBox.classList.remove("hidden");
      return;
    }
    idleBox.classList.add("hidden");
    taskBox.classList.remove("hidden");
    renderTask(task, team);
  }

  // ---------- Task card ----------

  function renderTask(task, team) {
    var esc = Vigora.escapeHtml;
    var type = (Vigora.meta && Vigora.meta.byKey[task.type]) || null;
    var next = NEXT_STEP[task.status];
    var confirmations = (task.reports_count - 1) + task.witness_yes;
    var descriptions = task.reports
      .map(function (r) { return (r.description || "").trim(); })
      .filter(Boolean);

    var html = "";
    if (task.status === "assigned") {
      html += '<div class="task-banner" role="alert">Нова задача от 112. Потвърдете, че я поемате.</div>';
    }

    html +=
      '<article class="task-card">' +
        '<div class="task-map" id="task-map" aria-label="Карта на мястото"></div>' +
        '<div class="task-body">' +
          '<div class="task-head">' +
            "<div>" +
              '<h1 class="task-type">' +
                (type && type.icon ? '<span class="icon" aria-hidden="true">' + esc(type.icon) + "</span>" : "") +
                esc(task.type_label) +
              "</h1>" +
              '<p class="task-meta">' + esc(task.status_label) + " · Получен в " + esc(Vigora.clock(task.created_at)) + "</p>" +
            "</div>" +
            '<div class="task-urgency level-' + esc(task.level) + '" title="Спешност">' +
              "<strong>" + esc(task.urgency) + "</strong>" +
              "<small>" + esc(LEVEL_WORDS[task.level] || task.level) + "</small>" +
            "</div>" +
          "</div>" +
          progressHtml(task.status) +
          '<dl class="facts">' +
            "<div><dt>Засегнати</dt><dd>" + esc(task.people_affected) + "</dd></div>" +
            "<div><dt>Потвърждения</dt><dd>" + esc(confirmations) + "</dd></div>" +
            "<div><dt>Снимки</dt><dd>" + (task.has_photo ? "да" : "не") + "</dd></div>" +
          "</dl>" +
          '<section class="descriptions">' +
            "<h2>Описания от гражданите</h2>" +
            (descriptions.length
              ? "<ul>" + descriptions.map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("") + "</ul>"
              : '<p class="hint">Няма описание от подателите.</p>') +
          "</section>" +
          '<div class="task-actions">' +
            (next
              ? '<button type="button" class="btn btn-next" id="next-step" data-status="' + esc(next.status) + '">' +
                  esc(next.label) +
                "</button>"
              : "") +
            '<a class="nav-link" target="_blank" rel="noopener" href="' + esc(directionsUrl(task)) + '">' +
              "Навигация до мястото" +
            "</a>" +
          "</div>" +
        "</div>" +
      "</article>";

    removeMap();
    taskBox.innerHTML = html;

    var button = document.getElementById("next-step");
    if (button) button.addEventListener("click", function () { sendStatus(button); });

    drawMap(task, team);
  }

  function progressHtml(status) {
    var done = STEPS_DONE[status] || 0;
    return (
      '<ol class="progress" aria-label="Напредък">' +
      STEPS.map(function (step, index) {
        var state = index < done ? "done" : index === done ? "next" : "";
        return '<li class="' + state + '">' + Vigora.escapeHtml(step.label) + "</li>";
      }).join("") +
      "</ol>"
    );
  }

  function directionsUrl(task) {
    return "https://www.google.com/maps/dir/?api=1&destination=" + task.lat + "," + task.lng;
  }

  // ---------- Map ----------

  // The card is drawn again on every change, so the map is made again too, without animations.
  function drawMap(task, team) {
    var element = document.getElementById("task-map");
    if (!element || typeof L === "undefined") return;
    map = Vigora.makeMap(element, { center: [task.lat, task.lng], zoom: 15, animate: false });
    var incidentMarker = L.marker([task.lat, task.lng], {
      icon: Vigora.incidentIcon(task.type, { level: task.level }),
      keyboard: false,
    }).addTo(map);
    var teamMarker = L.marker([team.lat, team.lng], {
      icon: Vigora.teamIcon(team),
      keyboard: false,
    }).addTo(map);
    var bounds = L.latLngBounds([incidentMarker.getLatLng(), teamMarker.getLatLng()]);
    map.invalidateSize({ animate: false }); // the card was just drawn; measure it first
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: false });
  }

  function removeMap() {
    if (map) map.remove();
    map = null;
  }

  // ---------- Next step ----------

  async function sendStatus(button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      await Vigora.request("/api/teams/me/status", {
        method: "POST",
        json: { status: button.dataset.status },
      });
      if (button.dataset.status === "resolved") Vigora.toast("Задачата е приключена.");
    } catch (e) {
      Vigora.toast(e.message, { error: true });
    } finally {
      busy = false;
      button.disabled = false;
      load();
    }
  }

  // ---------- Start and stop ----------

  function onEvent(event) {
    if (event === "team.task") load();
  }

  function start() {
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    loadingBox.classList.remove("hidden");
    setConnection(false);
    connLabel.textContent = "Свързване…";

    Vigora.loadMeta()
      .then(function () { if (lastTaskId) load(); }) // the type icon needs the meta data
      .catch(function () { /* the card works without the icons */ });
    load();
    // onOpen also runs after every reconnect, so a task sent while offline is not missed.
    socket = Vigora.connect({ onStatus: setConnection, onEvent: onEvent, onOpen: load });
  }

  function stop() {
    loadRequest++;
    if (socket) socket.close();
    socket = null;
    removeMap();
    lastTaskId = undefined;
    taskBox.innerHTML = "";
    taskBox.classList.add("hidden");
    idleBox.classList.add("hidden");
    document.getElementById("team-name").textContent = "";
  }

  // A login from earlier in this tab is reused; an account of another role is dropped.
  var session = Vigora.session;
  if (session && session.user && session.user.role === "team") {
    start();
  } else {
    if (session) Vigora.setSession(null);
    loginScreen.classList.remove("hidden");
  }
})();
