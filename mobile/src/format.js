// Small text helpers, the same wording as the web apps.

function toDate(value) {
  // The server sends UTC times; add the "Z" if it is missing.
  if (typeof value === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(value)) value += "Z";
  return new Date(value);
}

export function timeAgo(value) {
  const seconds = Math.max(0, Math.round((Date.now() - toDate(value).getTime()) / 1000));
  if (seconds < 45) return "току-що";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return "преди " + minutes + " мин";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return "преди " + hours + " ч";
  const days = Math.floor(hours / 24);
  return days === 1 ? "преди 1 ден" : "преди " + days + " дни";
}

export function people(n) {
  return n === 1 ? "1 човек" : n + " души";
}

export function formatDistance(meters) {
  if (meters == null || isNaN(meters)) return "";
  if (meters < 1000) return Math.round(meters / 10) * 10 + " м";
  return (meters / 1000).toFixed(1) + " км";
}

export { toDate };
