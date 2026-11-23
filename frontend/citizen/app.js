/* Citizen app: login, registration, the home screen with the incident types and sending a report. */
(function () {
  "use strict";

  var loginScreen = document.getElementById("login-screen");
  var appScreen = document.getElementById("app-screen");
  var form = document.getElementById("login-form");
  var errorBox = document.getElementById("login-error");
  var fullNameField = document.getElementById("full-name-field");
  var submitButton = document.getElementById("login-submit");
  var modeToggle = document.getElementById("mode-toggle");
  var demoAccounts = document.getElementById("demo-accounts");
  var connLabel = document.getElementById("conn");

  var registering = false;
  var socket = null;

  // ---------- 3D tilt ----------

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Tilt an element toward the mouse pointer and move its light reflex. Touch is left alone,
  // so scrolling on a phone never makes the cards wobble.
  function addTilt(element, maxDegrees) {
    if (reducedMotion) return;
    element.addEventListener("pointermove", function (event) {
      if (event.pointerType !== "mouse") return;
      var box = element.getBoundingClientRect();
      var x = (event.clientX - box.left) / box.width;
      var y = (event.clientY - box.top) / box.height;
      element.style.setProperty("--ry", ((x - 0.5) * maxDegrees).toFixed(2) + "deg");
      element.style.setProperty("--rx", ((0.5 - y) * maxDegrees).toFixed(2) + "deg");
      element.style.setProperty("--mx", (x * 100).toFixed(1) + "%");
      element.style.setProperty("--my", (y * 100).toFixed(1) + "%");
    });
    element.addEventListener("pointerleave", function () {
      element.style.setProperty("--rx", "0deg");
      element.style.setProperty("--ry", "0deg");
    });
  }

  addTilt(document.querySelector(".login-card"), 8);
  addTilt(document.getElementById("status-card"), 10);

  // ---------- Login and registration ----------

  function showError(text) {
    errorBox.textContent = text || "";
    errorBox.classList.toggle("hidden", !text);
  }

  function setMode(register) {
    registering = register;
    fullNameField.classList.toggle("hidden", !register);
    demoAccounts.classList.toggle("hidden", register);
    submitButton.textContent = register ? "Регистрация" : "Вход";
    modeToggle.textContent = register ? "Имате акаунт? Вход" : "Нямате акаунт? Регистрация";
    form.elements.password.autocomplete = register ? "new-password" : "current-password";
    showError("");
    (register ? form.elements.full_name : form.elements.username).focus();
  }

  modeToggle.addEventListener("click", function () {
    setMode(!registering);
  });

  // In registration mode this runs before the login handler of Vigora.setupLogin and stops it.
  form.addEventListener(
    "submit",
    async function (event) {
      if (!registering) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      var fullName = form.elements.full_name.value.trim();
      var username = form.elements.username.value.trim();
      var password = form.elements.password.value;
      if (fullName.length < 2) return showError("Въведете име и фамилия.");
      if (username.length < 3) return showError("Потребителското име трябва да е поне 3 знака.");
      if (password.length < 6) return showError("Паролата трябва да е поне 6 знака.");

      showError("");
      submitButton.disabled = true;
      try {
        var result = await Vigora.request("/api/auth/register", {
          method: "POST",
          json: { full_name: fullName, username: username, password: password },
        });
        Vigora.setSession(result);
        startApp();
      } catch (e) {
        showError(e.message);
      } finally {
        submitButton.disabled = false;
      }
    },
    true
  );

  Vigora.setupLogin({ role: "citizen", onSuccess: startApp });

  document.getElementById("logout").addEventListener("click", function () {
    Vigora.logout();
    socket = null;
    if (reportSheet.open) reportSheet.close();
    if (sentSheet.open) sentSheet.close();
    listRequest++; // drop a list that is still loading
    reportList.innerHTML = "";
    reportCount.textContent = "";
    form.reset();
    appScreen.classList.add("hidden");
    loginScreen.classList.remove("hidden");
  });

  // ---------- Home ----------

  function setConnection(online) {
    connLabel.classList.toggle("online", online);
    connLabel.classList.toggle("offline", !online);
    connLabel.textContent = online ? "На линия" : "Няма връзка";
  }

  function renderGreeting() {
    var name = (Vigora.session.user.full_name || "").trim().split(/\s+/)[0];
    document.getElementById("greeting").innerHTML = name
      ? 'Здравейте, <span class="name">' + Vigora.escapeHtml(name) + "</span>. Какво се случва?"
      : "Здравейте. Какво се случва?";
  }

  // Line icons per incident type. A type without one falls back to the icon from /api/meta.
  var SVG_START =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var TYPE_ICONS = {
    // Heart with a pulse line
    medical: '<path d="M19.5 12.6 12 20l-7.5-7.4A4.8 4.8 0 0 1 12 6.3a4.8 4.8 0 0 1 7.5 6.3z"/><path d="M4 12h4l1.5-2.5 3 5L14 12h6"/>',
    // Flame
    fire: '<path d="M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.6-2.6-5.9-4-8.8-.4 2-1.6 3.4-2.8 3.9C12 7 10.6 4.6 8.6 3c.2 3-3.1 5.6-3.1 10.3C5.5 18.2 8.2 21 12 21z"/><path d="M12 21c-1.7 0-3-1.2-3-3 0-2 1.5-3 2.2-4.8 1.3 1.1 3.8 2.6 3.8 4.8 0 1.8-1.3 3-3 3z"/>',
    // Shield with an exclamation mark
    violence: '<path d="M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6z"/><path d="M12 8v4.5M12 16h.01"/>',
    // Car
    accident: '<path d="M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5"/><path d="M4 12h16v4.5H4z"/><circle cx="7.5" cy="18" r="1.5"/><circle cx="16.5" cy="18" r="1.5"/>',
    // Eye
    suspicious: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    // Three dots in a circle
    other: '<circle cx="12" cy="12" r="9"/><path d="M8 12h.01M12 12h.01M16 12h.01" stroke-width="2.6"/>',
  };

  function typeIconHtml(type) {
    var path = TYPE_ICONS[type.key];
    return path ? SVG_START + path + "</svg>" : Vigora.escapeHtml(type.icon);
  }

  function renderTypes(meta) {
    var grid = document.getElementById("type-grid");
    grid.innerHTML = meta.types
      .map(function (t) {
        return (
          '<button type="button" class="type-tile" data-type="' + Vigora.escapeHtml(t.key) +
          '" style="--type-color:' + Vigora.escapeHtml(t.color) + '">' +
          (t.life_threatening ? '<span class="type-urgent">спешно</span>' : "") +
          '<span class="type-icon" aria-hidden="true">' + typeIconHtml(t) + "</span>" +
          '<span class="type-label">' + Vigora.escapeHtml(t.label) + "</span>" +
          "</button>"
        );
      })
      .join("");
    grid.querySelectorAll(".type-tile").forEach(function (tile) {
      addTilt(tile, 16);
    });
  }

  async function loadTypes() {
    var grid = document.getElementById("type-grid");
    grid.innerHTML = '<p class="hint grid-message">Зареждане…</p>';
    try {
      renderTypes(await Vigora.loadMeta());
    } catch (e) {
      grid.innerHTML =
        '<p class="error-text grid-message">' + Vigora.escapeHtml(e.message) + "</p>";
    }
  }

  // ---------- Report ----------

  var SOFIA = [42.6977, 23.3219];
  var MAX_PEOPLE = 100;

  var reportSheet = document.getElementById("report-sheet");
  var sentSheet = document.getElementById("sent-sheet");
  var reportForm = document.getElementById("report-form");
  var reportError = document.getElementById("report-error");
  var reportSubmit = document.getElementById("report-submit");
  var description = document.getElementById("report-description");
  var photoInput = document.getElementById("report-photo");
  var peopleValue = document.getElementById("people-value");
  var peopleMinus = document.getElementById("people-minus");
  var peoplePlus = document.getElementById("people-plus");

  var myLocation = null; // [lat, lng] from the GPS, if the citizen allowed it
  var reportMap = null;
  var reportPin = null;
  var currentType = null;
  var people = 0;
  var sending = false;

  var statusCard = document.getElementById("status-card");

  function setLocationStatus(state, text, chip) {
    statusCard.dataset.state = state;
    document.getElementById("loc-text").textContent = text;
    document.getElementById("loc-chip").textContent = chip;
  }

  // Ask for the GPS location once. Without it the map starts in Sofia.
  function locate() {
    if (!navigator.geolocation) {
      setLocationStatus("off", "Посочете мястото на картата", "Няма GPS");
      return;
    }
    setLocationStatus("pending", "Търсим…", "GPS");
    navigator.geolocation.getCurrentPosition(
      function (position) {
        myLocation = [position.coords.latitude, position.coords.longitude];
        var accuracy = Math.round(position.coords.accuracy || 0);
        setLocationStatus(
          "found",
          "Определено" + (accuracy ? " · ±" + Vigora.formatDistance(accuracy) : ""),
          "GPS включен"
        );
      },
      function () {
        // Denied or unavailable: the citizen places the pin by hand.
        setLocationStatus("off", "Посочете мястото на картата", "GPS изключен");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }

  function pinIcon() {
    return L.divIcon({
      className: "vigora-icon",
      html: '<div class="marker-pin"></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 36],
    });
  }

  function ensureMap() {
    if (reportMap) return;
    reportMap = Vigora.makeMap(document.getElementById("report-map"), { zoom: 16 });
    reportPin = L.marker(SOFIA, { icon: pinIcon(), draggable: true, keyboard: true }).addTo(reportMap);
    reportMap.on("click", function (e) {
      reportPin.setLatLng(e.latlng);
    });
  }

  function setPeople(value) {
    people = Math.max(0, Math.min(MAX_PEOPLE, value));
    peopleValue.textContent = people;
    peopleMinus.disabled = people === 0;
    peoplePlus.disabled = people === MAX_PEOPLE;
  }

  peopleMinus.addEventListener("click", function () { setPeople(people - 1); });
  peoplePlus.addEventListener("click", function () { setPeople(people + 1); });

  description.addEventListener("input", function () {
    document.getElementById("report-count").textContent = description.value.length;
  });

  function showReportError(text) {
    reportError.textContent = text || "";
    reportError.classList.toggle("hidden", !text);
  }

  function setSending(value) {
    sending = value;
    reportSubmit.disabled = value;
    reportSubmit.textContent = value ? "Изпращане…" : "Изпрати сигнала";
  }

  function openReport(typeKey) {
    var type = Vigora.meta && Vigora.meta.byKey[typeKey];
    if (!type) return;
    currentType = type;

    var icon = document.getElementById("report-icon");
    icon.innerHTML = typeIconHtml(type);
    icon.style.setProperty("--type-color", type.color);
    document.getElementById("report-title").textContent = type.label;
    document.getElementById("report-danger").classList.toggle("hidden", !type.life_threatening);

    reportForm.reset();
    document.getElementById("report-count").textContent = "0";
    setPeople(0);
    setSending(false);
    showReportError("");

    reportSheet.showModal();
    ensureMap();
    var start = myLocation || SOFIA;
    reportPin.setLatLng(start);
    reportMap.setView(start, myLocation ? 17 : 14, { animate: false });
    // The map was measured while hidden; let Leaflet read its real size now.
    requestAnimationFrame(function () {
      reportMap.invalidateSize();
    });
  }

  document.getElementById("type-grid").addEventListener("click", function (event) {
    var tile = event.target.closest(".type-tile");
    if (tile) openReport(tile.dataset.type);
  });

  function sentMessage(result) {
    if (result.merged) {
      return "Други хора вече са съобщили за това. Вашият сигнал е добавен като потвърждение и вдига спешността му.";
    }
    if (result.witnesses_asked > 0) {
      return "Операторът на 112 го вижда. Попитахме " + Vigora.people(result.witnesses_asked) +
        " наблизо дали го потвърждават.";
    }
    return "Операторът на 112 го вижда. Ще ви уведомим, когато екип поеме случая.";
  }

  reportForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (sending || !currentType) return;

    var point = reportPin.getLatLng();
    var data = new FormData();
    data.append("type", currentType.key);
    data.append("lat", point.lat.toFixed(6));
    data.append("lng", point.lng.toFixed(6));
    data.append("description", description.value.trim());
    data.append("people_affected", String(people));
    if (photoInput.files && photoInput.files[0]) data.append("photo", photoInput.files[0]);

    showReportError("");
    setSending(true);
    try {
      var result = await Vigora.request("/api/reports", { method: "POST", form: data });
      reportSheet.close();
      document.getElementById("sent-text").textContent = sentMessage(result);
      sentSheet.showModal();
      loadMyReports();
    } catch (e) {
      showReportError(e.message);
    } finally {
      setSending(false);
    }
  });

  // Close buttons, and a click on the dark area around a sheet. Escape is handled by <dialog>.
  [reportSheet, sentSheet].forEach(function (sheet) {
    sheet.addEventListener("click", function (event) {
      if (event.target.closest("[data-close]") || event.target === sheet) sheet.close();
    });
  });

  // ---------- My reports ----------

  var reportList = document.getElementById("my-reports");
  var reportCount = document.getElementById("my-reports-count");
  var listRequest = 0; // only the newest load may draw the list

  function statusPillClass(status) {
    if (status === "resolved") return "pill pill-green";
    if (status === "false_report") return "pill pill-red";
    return "pill pill-blue";
  }

  function reportHtml(report, highlightId) {
    var type = Vigora.meta && Vigora.meta.byKey[report.type];
    var meta = Vigora.timeAgo(report.created_at);
    if (report.confirmations > 0) meta += ", потвърден от " + Vigora.people(report.confirmations);
    return (
      '<article class="report-item' + (report.incident_id === highlightId ? " changed" : "") + '"' +
      (type ? ' style="--type-color:' + Vigora.escapeHtml(type.color) + '"' : "") + ">" +
      '<div class="report-top">' +
      '<span class="report-type">' + Vigora.escapeHtml(report.type_label) + "</span>" +
      '<span class="' + statusPillClass(report.status) + '">' + Vigora.escapeHtml(report.status_label) + "</span>" +
      "</div>" +
      (report.description ? '<p class="report-desc">' + Vigora.escapeHtml(report.description) + "</p>" : "") +
      '<p class="report-meta">' + Vigora.escapeHtml(meta) + "</p>" +
      "</article>"
    );
  }

  // highlightId: the incident whose status just changed, so its card flashes once.
  async function loadMyReports(highlightId) {
    var request = ++listRequest;
    if (!reportList.children.length) reportList.innerHTML = '<p class="hint">Зареждане…</p>';
    try {
      var reports = await Vigora.request("/api/reports/mine");
      try {
        await Vigora.loadMeta(); // for the type colors; the list also works without them
      } catch (e) {
        /* ignore */
      }
      if (request !== listRequest) return;
      reportCount.textContent = reports.length ? String(reports.length) : "";
      reportList.innerHTML = reports.length
        ? reports.map(function (r) { return reportHtml(r, highlightId); }).join("")
        : '<p class="report-empty">Още нямате подадени сигнали.</p>';
    } catch (e) {
      if (request !== listRequest) return;
      reportList.innerHTML = '<p class="error-text">' + Vigora.escapeHtml(e.message) + "</p>";
    }
  }

  function onEvent(event, data) {
    if (event === "report.status") {
      Vigora.toast("Вашият сигнал: " + data.status_label);
      loadMyReports(data.incident_id);
    }
  }

  function startApp() {
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    renderGreeting();
    loadTypes();
    setConnection(false);
    connLabel.textContent = "Свързване…";
    loadMyReports();
    socket = Vigora.connect({ onStatus: setConnection, onEvent: onEvent });
    locate();
  }

  // A login from earlier in this tab is reused; an account of another role is dropped.
  var session = Vigora.session;
  if (session && session.user && session.user.role === "citizen") {
    startApp();
  } else {
    if (session) Vigora.setSession(null);
    loginScreen.classList.remove("hidden");
  }
})();
