/* Vigora citizen app: service worker for witness questions sent as push notifications.
 *
 * It only shows notifications and opens the app; it does not cache anything. A push carries
 * the question text and a link, never a location: the question itself is loaded by the app
 * after login (GET /api/witness/pending).
 */
"use strict";

var APP_PATH = "/citizen/";

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  var title = data.title || "Vigora: въпрос от 112";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "Имате въпрос като свидетел. Отворете приложението.",
      icon: APP_PATH + "icon.svg",
      tag: data.tag || "witness",
      renotify: true,
      requireInteraction: true,
      data: { url: safeUrl(data.url) },
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = new URL(safeUrl(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      // Reuse an open tab of the app; it loads the pending question when it comes to the front.
      for (var i = 0; i < windows.length; i++) {
        var client = windows[i];
        if (new URL(client.url).pathname.indexOf(APP_PATH) === 0 && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Only pages of this app can be opened from a notification.
function safeUrl(url) {
  return typeof url === "string" && url.indexOf(APP_PATH) === 0 ? url : APP_PATH;
}
