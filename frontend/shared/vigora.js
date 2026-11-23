/* Vigora — shared helpers for the citizen, operator and team apps.
 *
 * Every page sets <body data-app="citizen|operator|team">. The login result is kept in
 * sessionStorage, so each browser tab has its own login and several accounts can be
 * tested side by side in different tabs.
 */
(function () {
  "use strict";

  var OFFLINE_MESSAGE = "Няма връзка със сървъра. Проверете интернет връзката и опитайте отново.";
  var SOFIA = [42.6977, 23.3219];
  var FALLBACK_COLORS = {
    medical: "#2563eb",
    fire: "#dc2626",
    violence: "#7c3aed",
    accident: "#ea580c",
    suspicious: "#ca8a04",
    other: "#6b7280",
  };
  var TEAM_LETTERS = { medical: "М", fire: "П", police: "Р" };

  function appName() {
    return (document.body && document.body.dataset.app) || "app";
  }

  function storageKey() {
    return "vigora." + appName() + ".session";
  }

  // ---------- Session ----------

  var current; // undefined until first read, so it works even if the script is in <head>

  function getSession() {
    try {
      var raw = sessionStorage.getItem(storageKey());
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setSession(session) {
    try {
      if (session) sessionStorage.setItem(storageKey(), JSON.stringify(session));
      else sessionStorage.removeItem(storageKey());
    } catch (e) {
      /* Storage can be blocked; the app then works until the tab is reloaded. */
    }
    current = session;
  }

  // ---------- HTTP ----------

  function detailText(detail) {
    if (!detail) return null;
    if (typeof detail === "string") return detail;
    // FastAPI validation errors are a list of {msg, loc}.
    if (Array.isArray(detail) && detail.length) {
      return "Невалидни данни: " + detail.map(function (d) { return d.msg; }).join("; ");
    }
    return null;
  }

  async function request(path, options) {
    options = options || {};
    var headers = {};
    var body;
    var session = Vigora.session;
    if (session && session.access_token) {
      headers["Authorization"] = "Bearer " + session.access_token;
    }
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      body = options.form; // FormData; the browser sets the multipart boundary.
    }

    var response;
    try {
      response = await fetch(path, {
        method: options.method || (body !== undefined ? "POST" : "GET"),
        headers: headers,
        body: body,
      });
    } catch (e) {
      throw new Error(OFFLINE_MESSAGE);
    }

    var data = null;
    var text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = null;
      }
    }

    if (!response.ok) {
      // An expired or invalid token: start over. A wrong password at login has no token.
      if (response.status === 401 && headers["Authorization"]) {
        setSession(null);
        location.reload();
      }
      var message = detailText(data && data.detail) || "Грешка от сървъра (" + response.status + ").";
      var error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function login(username, password) {
    var result = await request("/api/auth/login", {
      method: "POST",
      json: { username: username, password: password },
    });
    setSession(result);
    return result;
  }

  function logout() {
    setSession(null);
    if (Vigora._socket) Vigora._socket.close();
  }

  var metaPromise = null;

  function loadMeta() {
    if (!metaPromise) {
      metaPromise = request("/api/meta")
        .then(function (meta) {
          meta.byKey = {};
          meta.types.forEach(function (t) { meta.byKey[t.key] = t; });
          meta.teamKindByKey = {};
          meta.team_kinds.forEach(function (k) { meta.teamKindByKey[k.key] = k; });
          meta.statusByKey = {};
          meta.statuses.forEach(function (s) { meta.statusByKey[s.key] = s; });
          Vigora.meta = meta;
          return meta;
        })
        .catch(function (e) {
          metaPromise = null; // allow a retry later
          throw e;
        });
    }
    return metaPromise;
  }

  // ---------- WebSocket ----------

  function connect(handlers) {
    handlers = handlers || {};
    var socket = null;
    var pingTimer = null;
    var retryTimer = null;
    var delay = 1000;
    var stopped = false;

    function status(online) {
      if (handlers.onStatus) handlers.onStatus(online);
    }

    function open() {
      var session = Vigora.session;
      if (!session || stopped) return;
      var scheme = location.protocol === "https:" ? "wss:" : "ws:";
      var url = scheme + "//" + location.host + "/ws?token=" + encodeURIComponent(session.access_token);
      socket = new WebSocket(url);
      Vigora._socket = { close: stop };

      socket.onopen = function () {
        delay = 1000;
        status(true);
        clearInterval(pingTimer);
        pingTimer = setInterval(function () { send({ type: "ping" }); }, 25000);
        if (handlers.onOpen) handlers.onOpen();
      };

      socket.onmessage = function (message) {
        var parsed;
        try {
          parsed = JSON.parse(message.data);
        } catch (e) {
          return;
        }
        if (parsed.event === "pong") return;
        if (handlers.onEvent) handlers.onEvent(parsed.event, parsed.data || {});
      };

      socket.onclose = function () {
        clearInterval(pingTimer);
        status(false);
        if (stopped) return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(open, delay);
        delay = Math.min(delay * 2, 15000);
      };

      socket.onerror = function () {
        /* onclose follows and schedules the reconnect. */
      };
    }

    function send(payload) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
        return true;
      }
      return false;
    }

    function stop() {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      if (socket) socket.close();
    }

    open();
    return { send: send, close: stop };
  }

  // ---------- Login form ----------

  function setupLogin(config) {
    config = config || {};
    var form = document.getElementById("login-form");
    var errorBox = document.getElementById("login-error");
    if (!form) return;

    function showError(text) {
      if (!errorBox) return;
      errorBox.textContent = text || "";
      errorBox.classList.toggle("hidden", !text);
    }

    async function attempt(username, password) {
      showError("");
      var submit = form.querySelector('[type="submit"]');
      if (submit) submit.disabled = true;
      try {
        var result = await login(username, password);
        if (config.role && result.user.role !== config.role) {
          setSession(null);
          showError("Този акаунт е за друго приложение.");
          return;
        }
        if (config.onSuccess) config.onSuccess(result);
      } catch (e) {
        showError(e.message);
      } finally {
        if (submit) submit.disabled = false;
      }
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var username = (form.elements.username && form.elements.username.value || "").trim();
      var password = form.elements.password ? form.elements.password.value : "";
      if (!username || !password) {
        showError("Въведете потребителско име и парола.");
        return;
      }
      attempt(username, password);
    });

    document.querySelectorAll("[data-demo-user]").forEach(function (button) {
      button.addEventListener("click", function () {
        var username = button.dataset.demoUser;
        var password = button.dataset.demoPass || "";
        if (form.elements.username) form.elements.username.value = username;
        if (form.elements.password) form.elements.password.value = password;
        attempt(username, password);
      });
    });
  }

  // ---------- Small helpers ----------

  var toastTimer = null;

  function toast(text, options) {
    options = options || {};
    var old = document.querySelector(".toast");
    if (old) old.remove();
    clearTimeout(toastTimer);
    var el = document.createElement("div");
    el.className = "toast" + (options.error ? " error" : "");
    el.setAttribute("role", options.error ? "alert" : "status");
    el.textContent = text;
    document.body.appendChild(el);
    toastTimer = setTimeout(function () { el.remove(); }, options.ms || (options.error ? 5000 : 3000));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toDate(value) {
    if (value instanceof Date) return value;
    // The server sends UTC times; add "Z" when the zone is missing.
    if (typeof value === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(value)) value += "Z";
    return new Date(value);
  }

  function timeAgo(value) {
    var seconds = Math.max(0, Math.round((Date.now() - toDate(value).getTime()) / 1000));
    if (seconds < 45) return "току-що";
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return "преди " + minutes + " мин";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return "преди " + hours + " ч";
    var days = Math.floor(hours / 24);
    return days === 1 ? "преди 1 ден" : "преди " + days + " дни";
  }

  function clock(value) {
    var date = value === undefined ? new Date() : toDate(value);
    var hh = String(date.getHours()).padStart(2, "0");
    var mm = String(date.getMinutes()).padStart(2, "0");
    return hh + ":" + mm;
  }

  function people(n) {
    return n === 1 ? "1 човек" : n + " души";
  }

  function formatDistance(meters) {
    if (meters == null || isNaN(meters)) return "";
    if (meters < 1000) return Math.round(meters / 10) * 10 + " м";
    return (meters / 1000).toFixed(1) + " км";
  }

  // ---------- Map ----------

  function makeMap(element, options) {
    options = options || {};
    var map = L.map(element, {
      zoomControl: true,
      zoomAnimation: options.animate !== false,
      fadeAnimation: options.animate !== false,
      markerZoomAnimation: options.animate !== false,
    }).setView(options.center || SOFIA, options.zoom || 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    return map;
  }

  function incidentIcon(type, options) {
    options = options || {};
    var info = typeof type === "object" && type ? type : (Vigora.meta && Vigora.meta.byKey[type]) || null;
    var key = info ? info.key : type;
    var color = (info && info.color) || FALLBACK_COLORS[key] || FALLBACK_COLORS.other;
    var glyph = (info && info.icon) || "";
    var classes = ["marker-incident"];
    if (options.level) classes.push("level-" + options.level);
    if (options.selected) classes.push("selected");
    return L.divIcon({
      className: "vigora-icon",
      html: '<div class="' + classes.join(" ") + '" style="--marker-color:' + escapeHtml(color) + '">' +
        escapeHtml(glyph) + "</div>",
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -16],
    });
  }

  function teamIcon(team) {
    var letter = TEAM_LETTERS[team.kind] || (team.name || "?").charAt(0).toUpperCase();
    var busy = team.status && team.status !== "available";
    return L.divIcon({
      className: "vigora-icon",
      html: '<div class="marker-team' + (busy ? " busy" : "") + '" title="' + escapeHtml(team.name) + '">' +
        escapeHtml(letter) + "</div>",
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -12],
    });
  }

  function meIcon() {
    return L.divIcon({
      className: "vigora-icon",
      html: '<div class="marker-me"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  var Vigora = {
    get session() {
      if (current === undefined && document.body) current = getSession();
      return current || null;
    },
    meta: null,
    getSession: getSession,
    setSession: setSession,
    request: request,
    login: login,
    logout: logout,
    loadMeta: loadMeta,
    connect: connect,
    setupLogin: setupLogin,
    toast: toast,
    escapeHtml: escapeHtml,
    timeAgo: timeAgo,
    clock: clock,
    people: people,
    formatDistance: formatDistance,
    makeMap: makeMap,
    incidentIcon: incidentIcon,
    teamIcon: teamIcon,
    meIcon: meIcon,
  };

  window.Vigora = Vigora;
})();
