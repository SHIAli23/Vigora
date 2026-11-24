// Talking to the Vigora backend: REST requests, the session and the live WebSocket.

import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

const SESSION_KEY = "vigora.citizen.session";
const SERVER_KEY = "vigora.citizen.server";
const DEFAULT_PORT = 8000;

let server = null;
let session = null;

// ---------- Server address ----------

// The phone reaches the backend on the same computer that runs "npx expo start".
// Expo tells us that computer's address on the local network, so the default is that
// address with the backend's port. EXPO_PUBLIC_API_URL or the login screen can change it.
export function defaultServer() {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const hostUri = Constants.expoConfig?.hostUri || "";
  const host = hostUri.split(":")[0];
  return host ? `http://${host}:${DEFAULT_PORT}` : `http://localhost:${DEFAULT_PORT}`;
}

function cleanServer(value) {
  let text = (value || "").trim().replace(/\/+$/, "");
  if (text && !/^https?:\/\//i.test(text)) text = "http://" + text;
  return text;
}

export function getServer() {
  return server || defaultServer();
}

// Only an address typed by hand is remembered, so the automatic one follows the computer
// when its address on the network changes.
export async function setServer(value) {
  const cleaned = cleanServer(value);
  server = cleaned && cleaned !== defaultServer() ? cleaned : null;
  if (server) await SecureStore.setItemAsync(SERVER_KEY, server);
  else await SecureStore.deleteItemAsync(SERVER_KEY);
}

// ---------- Session ----------

export function getSession() {
  return session;
}

export async function loadStored() {
  try {
    server = (await SecureStore.getItemAsync(SERVER_KEY)) || null;
    const text = await SecureStore.getItemAsync(SESSION_KEY);
    session = text ? JSON.parse(text) : null;
  } catch (e) {
    session = null;
  }
  return session;
}

async function setSession(value) {
  session = value;
  if (value) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(value));
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function logout() {
  await setSession(null);
}

// Called when the server says the login is no longer valid.
let onExpired = null;
export function setOnExpired(handler) {
  onExpired = handler;
}

// ---------- Requests ----------

function detailText(detail) {
  if (!detail) return null;
  if (typeof detail === "string") return detail;
  // FastAPI validation errors are a list of {msg, loc}.
  if (Array.isArray(detail) && detail.length) {
    return "Невалидни данни: " + detail.map((d) => d.msg).join("; ");
  }
  return null;
}

// options: { method, json, form }. Throws an Error with .status for server errors;
// an Error without .status means there was no connection.
export async function request(path, options = {}) {
  const headers = { Accept: "application/json" };
  let body;
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form; // fetch sets the multipart boundary itself
  }

  let response;
  try {
    response = await fetch(getServer() + path, { method: options.method || "GET", headers, body });
  } catch (e) {
    throw new Error("Няма връзка със сървъра " + getServer() + ".");
  }

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 401 && headers.Authorization) {
      await setSession(null);
      if (onExpired) onExpired();
    }
    const error = new Error(
      detailText(data && data.detail) || "Грешка от сървъра (" + response.status + ")."
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

function checkCitizen(result) {
  if (result.user.role !== "citizen") {
    throw new Error("Този акаунт не е на гражданин. Използвайте приложението за граждани с личен акаунт.");
  }
  return result;
}

export async function login(username, password) {
  const result = checkCitizen(
    await request("/api/auth/login", { method: "POST", json: { username, password } })
  );
  await setSession(result);
  return result;
}

export async function register(fullName, username, password) {
  const result = await request("/api/auth/register", {
    method: "POST",
    json: { full_name: fullName, username, password },
  });
  await setSession(result);
  return result;
}

// ---------- Reference data ----------

let meta = null;

export async function loadMeta() {
  if (meta) return meta;
  const data = await request("/api/meta");
  data.byKey = {};
  data.types.forEach((t) => (data.byKey[t.key] = t));
  meta = data;
  return meta;
}

// ---------- Photos ----------

// A photo from the camera or the gallery, as a multipart file part.
export function photoPart(asset) {
  const type = asset.mimeType || "image/jpeg";
  const ext = type.split("/")[1] === "png" ? "png" : type.split("/")[1] === "webp" ? "webp" : "jpg";
  return { uri: asset.uri, name: asset.fileName || "photo." + ext, type };
}

// ---------- Live events ----------

// Open the WebSocket and keep it open: a ping every 25 s, and a reconnect with a growing
// pause (up to 15 s) after it drops. Returns { send, close }.
export function connect({ onEvent, onStatus, onOpen }) {
  let socket = null;
  let closed = false;
  let retry = 1000;
  let pingTimer = null;
  let retryTimer = null;

  function open() {
    if (closed || !session) return;
    const url = getServer().replace(/^http/i, "ws") + "/ws?token=" + encodeURIComponent(session.access_token);
    socket = new WebSocket(url);

    socket.onopen = () => {
      retry = 1000;
      onStatus && onStatus(true);
      pingTimer = setInterval(() => send({ type: "ping" }), 25000);
      onOpen && onOpen();
    };
    socket.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data);
        if (data && data.event) onEvent && onEvent(data.event, data.data || {});
      } catch (e) {
        /* not JSON: ignore */
      }
    };
    socket.onclose = () => {
      clearInterval(pingTimer);
      onStatus && onStatus(false);
      if (closed) return;
      retryTimer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  function send(data) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(data));
  }

  open();
  return {
    send,
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      if (socket) socket.close();
    },
  };
}
