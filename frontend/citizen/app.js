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

  document.getElementById("logout").addEventListener("click", async function () {
    // The next person on this browser must not get this citizen's witness questions.
    await disableNotifications();
    Vigora.logout();
    socket = null;
    if (reportSheet.open) reportSheet.close();
    if (sentSheet.open) sentSheet.close();
    resetWitness();
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
  photoInput.addEventListener("change", function () { showPhotoChosen(photoInput); });
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

  // Ask for the GPS location. Without it the map starts in Sofia.
  // done(ok) is optional and is called once the browser answers.
  function locate(done) {
    if (!navigator.geolocation) {
      setLocationStatus("off", "Посочете мястото на картата", "Няма GPS");
      if (done) done(false);
      return;
    }
    if (!myLocation) setLocationStatus("pending", "Търсим…", "GPS");
    navigator.geolocation.getCurrentPosition(
      function (position) {
        myLocation = [position.coords.latitude, position.coords.longitude];
        var accuracy = Math.round(position.coords.accuracy || 0);
        setLocationStatus(
          "found",
          "Определено" + (accuracy ? " · ±" + Vigora.formatDistance(accuracy) : ""),
          "GPS включен"
        );
        locationChanged();
        if (done) done(true);
      },
      function () {
        // Denied or unavailable: the citizen places the pin by hand.
        if (!myLocation) setLocationStatus("off", "Посочете мястото на картата", "GPS изключен");
        if (done) done(false);
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

  // The file input is hidden behind the "Снимай сега" button, so say when a photo is attached.
  function showPhotoChosen(input) {
    var chosen = input.files && input.files.length > 0;
    document.getElementById(input.id + "-chosen").classList.toggle("hidden", !chosen);
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
    showPhotoChosen(photoInput);
    document.getElementById("report-count").textContent = "0";
    setPeople(0);
    setSending(false);
    showReportError("");

    reportSheet.showModal();
    ensureMap();
    var known = currentLocation();
    var start = known || SOFIA;
    reportPin.setLatLng(start);
    reportMap.setView(start, known ? 17 : 14, { animate: false });
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

  // The way a report goes from sent to resolved, drawn as a track of five steps.
  var TRACK = ["new", "assigned", "accepted", "on_scene", "resolved"];

  function trackHtml(status) {
    var stopped = status === "false_report";
    var reached = stopped ? 0 : TRACK.indexOf(status);
    var steps = TRACK.map(function (key, i) {
      var state = i < reached ? "done" : i === reached ? "current" : "";
      if (status === "resolved" && i === reached) state = "done";
      return '<i class="' + state + '"></i>';
    }).join("");
    return '<div class="report-track' + (stopped ? " stopped" : "") + '" aria-hidden="true">' + steps + "</div>";
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
      trackHtml(report.status) +
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

  // ---------- Witness mode: location ----------

  var WITNESS_KEY = "vigora.citizen.witness";
  var SHARE_EVERY_MS = 60000;

  var witnessCard = document.querySelector(".witness-card");
  var witnessSwitch = document.getElementById("witness-switch");
  var witnessLoc = document.getElementById("witness-loc");
  var locationSheet = document.getElementById("location-sheet");
  var locationError = document.getElementById("location-error");

  var witnessOn = false;
  var manualLocation = null; // [lat, lng] chosen on the map; kept in memory only
  var locationMap = null;
  var locationMarker = null;

  // A point picked by hand wins over the GPS, because the citizen chose it on purpose.
  function currentLocation() {
    return manualLocation || myLocation;
  }

  function renderWitnessLocation() {
    var text = manualLocation ? "зададено ръчно" : myLocation ? "по GPS" : "още не е определено";
    witnessLoc.textContent = text;
    witnessLoc.classList.toggle("set", Boolean(currentLocation()));
  }

  // Send the location to the server while witness mode is on. Called right away, after every
  // (re)connect and every minute, so the server never holds a stale point.
  function shareLocation() {
    var point = currentLocation();
    if (!witnessOn || !socket || !point) return;
    socket.send({ type: "location", lat: point[0], lng: point[1] });
  }

  function locationChanged() {
    renderWitnessLocation();
    shareLocation();
  }

  function setWitness(on, remember) {
    witnessOn = on;
    witnessSwitch.setAttribute("aria-checked", on ? "true" : "false");
    witnessCard.classList.toggle("on", on);
    if (remember) {
      try {
        sessionStorage.setItem(WITNESS_KEY, on ? "on" : "off");
      } catch (e) {
        /* storage blocked: the switch still works until the tab closes */
      }
    }
    if (on) {
      shareLocation();
      // Only when the citizen just switched it on, not when the choice is restored on load.
      if (remember && !currentLocation()) Vigora.toast("Изберете местоположението си на картата.");
      // Asking for notification permission must come from a click, so only then may we ask.
      enableNotifications(remember);
    } else {
      if (socket) socket.send({ type: "location_off" });
      // Only when the citizen turns it off. A new tab starts with the switch off (for example
      // when opened from a notification), and that must not cancel the notifications.
      if (remember) disableNotifications();
    }
  }

  // ---------- Witness mode: notifications when the app is closed ----------

  var SW_URL = "/citizen/sw.js";

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  // The server's public key comes as base64url; the browser wants raw bytes.
  function keyToBytes(base64url) {
    var padded = (base64url + "===".slice((base64url.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(padded);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  // askPermission is true only right after the citizen turned witness mode on. When the choice
  // is restored on load we only renew an existing permission and never show the browser prompt.
  async function enableNotifications(askPermission) {
    if (!pushSupported()) return;
    try {
      var config = await Vigora.request("/api/push/key");
      if (!config.enabled) return;

      var permission = Notification.permission;
      if (permission === "default" && askPermission) permission = await Notification.requestPermission();
      if (permission !== "granted") {
        if (askPermission && permission === "denied") {
          Vigora.toast("Известията са спрени в браузъра. Въпросите ще идват само докато приложението е отворено.");
        }
        return;
      }

      var registration = await navigator.serviceWorker.register(SW_URL);
      await navigator.serviceWorker.ready;
      var subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyToBytes(config.public_key),
        });
      }
      var data = subscription.toJSON();
      await Vigora.request("/api/push/subscribe", {
        method: "POST",
        json: { endpoint: data.endpoint, keys: data.keys },
      });
    } catch (e) {
      // Notifications are an extra: witness questions still work while the app is open.
    }
  }

  async function disableNotifications() {
    if (!pushSupported()) return;
    try {
      var registration = await navigator.serviceWorker.getRegistration(SW_URL);
      var subscription = registration && (await registration.pushManager.getSubscription());
      if (!subscription) return;
      await Vigora.request("/api/push/subscribe", { method: "DELETE", json: { endpoint: subscription.endpoint } });
      await subscription.unsubscribe();
    } catch (e) {
      /* nothing to undo */
    }
  }

  function storedWitnessChoice() {
    try {
      return sessionStorage.getItem(WITNESS_KEY) === "on";
    } catch (e) {
      return false;
    }
  }

  witnessSwitch.addEventListener("click", function () {
    setWitness(!witnessOn, true);
  });

  setInterval(shareLocation, SHARE_EVERY_MS);

  function placeLocationMarker(point) {
    if (locationMarker) locationMarker.setLatLng(point);
    else locationMarker = L.marker(point, { icon: Vigora.meIcon(), keyboard: false }).addTo(locationMap);
  }

  function showLocationError(text) {
    locationError.textContent = text || "";
    locationError.classList.toggle("hidden", !text);
  }

  document.getElementById("pick-location").addEventListener("click", function () {
    showLocationError("");
    locationSheet.showModal();
    if (!locationMap) {
      locationMap = Vigora.makeMap(document.getElementById("location-map"), { zoom: 14 });
      // A tap sets the location; this is the way to do it on a computer without GPS.
      locationMap.on("click", function (e) {
        manualLocation = [e.latlng.lat, e.latlng.lng];
        placeLocationMarker(manualLocation);
        showLocationError("");
        locationChanged();
      });
    }
    var point = currentLocation();
    if (point) placeLocationMarker(point);
    locationMap.setView(point || SOFIA, point ? 16 : 13, { animate: false });
    requestAnimationFrame(function () {
      locationMap.invalidateSize();
    });
  });

  document.getElementById("use-gps").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    showLocationError("");
    locate(function (ok) {
      button.disabled = false;
      if (!ok) {
        showLocationError("Няма достъп до GPS. Докоснете картата, за да зададете мястото ръчно.");
        return;
      }
      manualLocation = null;
      locationChanged();
      placeLocationMarker(myLocation);
      locationMap.setView(myLocation, 16);
    });
  });

  locationSheet.addEventListener("click", function (event) {
    if (event.target.closest("[data-close]") || event.target === locationSheet) locationSheet.close();
  });

  // ---------- Witness mode: questions ----------

  var questionSheet = document.getElementById("question-sheet");
  var questionError = document.getElementById("question-error");
  var questionTimer = document.getElementById("question-timer");
  var questionPhoto = document.getElementById("question-photo");
  questionPhoto.addEventListener("change", function () { showPhotoChosen(questionPhoto); });
  var answerButtons = questionSheet.querySelectorAll("[data-answer]");

  var queue = []; // questions waiting to be shown, oldest first
  var seenIds = {}; // every request_id ever queued, so a question never shows twice
  var currentQuestion = null;
  var answering = false;
  var timerId = null;
  var questionMap = null;
  var questionLayers = null;

  function deadlineOf(question) {
    var asked = question.asked_at;
    // The server sends UTC; add the zone if it is missing.
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(asked)) asked += "Z";
    return new Date(asked).getTime() + (question.expires_in_min || 10) * 60000;
  }

  function enqueue(question, isNew) {
    if (!question || seenIds[question.request_id]) return;
    seenIds[question.request_id] = true;
    question.deadline = deadlineOf(question);
    if (question.deadline <= Date.now()) return;
    queue.push(question);
    if (isNew && navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if (!currentQuestion) showNextQuestion();
  }

  async function loadPendingQuestions() {
    try {
      var pending = await Vigora.request("/api/witness/pending");
      // The server sends the newest first; the oldest expires first, so it goes first.
      pending.reverse().forEach(function (q) {
        enqueue(q, false);
      });
    } catch (e) {
      /* the next connect tries again */
    }
  }

  function formatLeft(ms) {
    var seconds = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(seconds / 60);
    return minutes + ":" + String(seconds % 60).padStart(2, "0");
  }

  function tick() {
    if (!currentQuestion) return;
    var left = currentQuestion.deadline - Date.now();
    if (left <= 0) {
      finishQuestion(); // time is up: hide it and go on
      return;
    }
    questionTimer.textContent = "Можете да отговорите още " + formatLeft(left) + " мин.";
    questionTimer.classList.toggle("soon", left < 60000);
  }

  function setAnswering(value) {
    answering = value;
    answerButtons.forEach(function (button) {
      button.disabled = value;
    });
  }

  function showQuestionError(text) {
    questionError.textContent = text || "";
    questionError.classList.toggle("hidden", !text);
  }

  function drawQuestionMap(question) {
    if (!questionMap) {
      questionMap = Vigora.makeMap(document.getElementById("question-map"), { zoom: 16 });
      questionLayers = L.layerGroup().addTo(questionMap);
    }
    questionLayers.clearLayers();
    var incident = [question.lat, question.lng];
    L.marker(incident, { icon: Vigora.incidentIcon(question.type), keyboard: false }).addTo(questionLayers);
    var me = currentLocation();
    if (me) {
      L.marker(me, { icon: Vigora.meIcon(), keyboard: false }).addTo(questionLayers);
      questionMap.fitBounds([incident, me], { padding: [30, 30], maxZoom: 17, animate: false });
    } else {
      questionMap.setView(incident, 16, { animate: false });
    }
    requestAnimationFrame(function () {
      questionMap.invalidateSize();
    });
  }

  function showNextQuestion() {
    clearInterval(timerId);
    currentQuestion = null;
    while (queue.length && queue[0].deadline <= Date.now()) queue.shift();
    if (!queue.length) {
      if (questionSheet.open) questionSheet.close();
      return;
    }
    var question = queue.shift();
    currentQuestion = question;

    var type = Vigora.meta && Vigora.meta.byKey[question.type];
    var icon = document.getElementById("question-icon");
    icon.innerHTML = type ? typeIconHtml(type) : "";
    icon.style.setProperty("--type-color", type ? type.color : "#6b7280");
    document.getElementById("question-where").textContent =
      question.type_label + ", на " + Vigora.formatDistance(question.distance_m) + " от вас";
    document.getElementById("question-text").textContent = question.question;
    questionPhoto.value = "";
    showPhotoChosen(questionPhoto);
    showQuestionError("");
    setAnswering(false);

    if (!questionSheet.open) questionSheet.showModal();
    drawQuestionMap(question);
    tick();
    timerId = setInterval(tick, 1000);
  }

  // Leave the current question (answered, expired or closed) and show the next one.
  function finishQuestion() {
    currentQuestion = null;
    showNextQuestion();
  }

  async function answer(value) {
    if (!currentQuestion || answering) return;
    var question = currentQuestion;
    var data = new FormData();
    data.append("answer", value);
    if (value === "yes" && questionPhoto.files && questionPhoto.files[0]) {
      data.append("photo", questionPhoto.files[0]);
    }
    showQuestionError("");
    setAnswering(true);
    try {
      await Vigora.request("/api/witness/" + question.request_id, { method: "POST", form: data });
      Vigora.toast(
        value === "yes" ? "Благодарим! Потвърждението ви помага на 112." : "Благодарим за отговора."
      );
      finishQuestion();
    } catch (e) {
      setAnswering(false);
      if (e.status) {
        // The server refused it (for example the time ran out): say why and go on.
        Vigora.toast(e.message, { error: true });
        finishQuestion();
      } else {
        // No connection: keep the question so the citizen can try again.
        showQuestionError(e.message);
      }
    }
  }

  answerButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      answer(button.dataset.answer);
    });
  });

  questionSheet.addEventListener("click", function (event) {
    if (event.target.closest("[data-close]") || event.target === questionSheet) questionSheet.close();
  });

  // Closed with the button or Escape without answering: skip to the next question.
  questionSheet.addEventListener("close", function () {
    if (currentQuestion) finishQuestion();
  });

  function resetWitness() {
    clearInterval(timerId);
    queue = [];
    seenIds = {};
    currentQuestion = null;
    manualLocation = null;
    if (questionSheet.open) questionSheet.close();
    if (locationSheet.open) locationSheet.close();
    try {
      sessionStorage.removeItem(WITNESS_KEY); // the next person in this tab decides for themselves
    } catch (e) {
      /* ignore */
    }
    setWitness(false, false);
    renderWitnessLocation();
  }

  // ---------- Live events ----------

  function onEvent(event, data) {
    if (event === "report.status") {
      Vigora.toast("Вашият сигнал: " + data.status_label);
      loadMyReports(data.incident_id);
    } else if (event === "witness.question") {
      enqueue(data, true);
    }
  }

  // After every (re)connect: send the location again and pick up questions missed while offline.
  function onOpen() {
    shareLocation();
    loadPendingQuestions();
  }

  function startApp() {
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    renderGreeting();
    loadTypes();
    setConnection(false);
    connLabel.textContent = "Свързване…";
    loadMyReports();
    setWitness(storedWitnessChoice(), false);
    renderWitnessLocation();
    socket = Vigora.connect({ onStatus: setConnection, onEvent: onEvent, onOpen: onOpen });
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
