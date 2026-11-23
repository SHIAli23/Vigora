/* Citizen app: login, registration and the home screen with the incident types. */
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

  function renderTypes(meta) {
    var grid = document.getElementById("type-grid");
    grid.innerHTML = meta.types
      .map(function (t) {
        return (
          '<button type="button" class="type-tile" data-type="' + Vigora.escapeHtml(t.key) +
          '" style="--type-color:' + Vigora.escapeHtml(t.color) + '">' +
          (t.life_threatening ? '<span class="type-urgent">спешно</span>' : "") +
          '<span class="type-icon" style="--type-color:' + Vigora.escapeHtml(t.color) + '" aria-hidden="true">' +
          Vigora.escapeHtml(t.icon) +
          "</span>" +
          '<span class="type-label">' + Vigora.escapeHtml(t.label) + "</span>" +
          "</button>"
        );
      })
      .join("");
    addTilt(grid.querySelectorAll(".type-tile"));
  }

  // Tilt the tiles toward the pointer for a 3D effect (mouse only, skipped with reduced motion).
  function addTilt(tiles) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    tiles.forEach(function (tile) {
      tile.addEventListener("pointermove", function (e) {
        if (e.pointerType !== "mouse") return;
        var r = tile.getBoundingClientRect();
        tile.style.setProperty("--ry", ((e.clientX - r.left) / r.width - 0.5) * 14 + "deg");
        tile.style.setProperty("--rx", (0.5 - (e.clientY - r.top) / r.height) * 12 + "deg");
      });
      tile.addEventListener("pointerleave", function () {
        tile.style.setProperty("--rx", "0deg");
        tile.style.setProperty("--ry", "0deg");
      });
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

  function startApp() {
    loginScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    renderGreeting();
    loadTypes();
    setConnection(false);
    connLabel.textContent = "Свързване…";
    socket = Vigora.connect({ onStatus: setConnection });
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
