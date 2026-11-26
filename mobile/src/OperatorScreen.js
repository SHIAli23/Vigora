// Operator 112 on the phone: the same panel as the web, stacked. Live stats, the map with
// incidents and teams, the incident queue by urgency and the detail area.

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Animated, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MapView, { Marker } from "react-native-maps";
import * as Haptics from "expo-haptics";

import * as api from "./api";
import IncidentDetail from "./IncidentDetail";
import { people, timeAgo } from "./format";
import { DARK_MAP, SOFIA } from "./sheets";
import { alpha, colors, fonts } from "./theme";
import { Button, ICONS, LineIcon, Toast, Wordmark, text } from "./ui";

const STATS_EVERY_MS = 15000;
const INCIDENTS_EVERY_MS = 30000; // waiting time raises the urgency, so reload now and then
const OPEN_STATUSES = ["new", "assigned", "accepted", "on_scene"];
const TEAM_LETTERS = { medical: "М", fire: "П", police: "Р" };
const LEVEL_WORDS = { critical: "критичен", high: "висок", medium: "среден", low: "нисък" };
const LEVEL_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
const LEVEL_COLORS = {
  critical: colors.red,
  high: colors.amber,
  medium: colors.blue,
  low: colors.inkFaint,
};

// Seconds as "45 с" or "3 мин"; "—" when there is nothing to measure yet.
function formatWait(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return seconds + " с";
  return Math.round(seconds / 60) + " мин";
}

// The highest urgency first; equal urgency: the one waiting longest first.
function sortIncidents(map) {
  return Array.from(map.values()).sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
}

// ---------- Stats ----------

// One number of the top bar. It flashes orange for a moment when it changes.
function Stat({ label, value, alert }) {
  const flash = useRef(new Animated.Value(0)).current;
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current !== value && previous.current !== "—") {
      flash.setValue(1);
      Animated.timing(flash, { toValue: 0, duration: 1200, useNativeDriver: false }).start();
    }
    previous.current = value;
  }, [value]);

  const color = alert ? "#ff7a70" : colors.ink;
  return (
    <View style={[styles.stat, alert && styles.statAlert]}>
      <Text style={[styles.statLabel, alert && { color: "#ff7a70" }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
      <Animated.Text
        style={[styles.statValue, { color: flash.interpolate({ inputRange: [0, 1], outputRange: [color, colors.orangeBright] }) }]}
      >
        {value}
      </Animated.Text>
    </View>
  );
}

// ---------- Map markers ----------

// A team: a square with a letter, orange when free, grey when busy.
function TeamMarker({ team }) {
  const busy = team.status !== "available";
  const letter = TEAM_LETTERS[team.kind] || (team.name || "?").charAt(0).toUpperCase();
  return (
    <Marker
      coordinate={{ latitude: team.lat, longitude: team.lng }}
      title={team.name}
      description={busy ? "зает" : "свободен"}
      anchor={{ x: 0.5, y: 0.5 }}
      zIndex={1}
    >
      <View style={[styles.team, busy && styles.teamBusy]}>
        <Text style={[styles.teamLetter, busy && { color: colors.inkFaint }]}>{letter}</Text>
      </View>
    </Marker>
  );
}

// An incident: a dot in the type color, with a red halo when critical and an orange ring
// when selected. Critical ones lie on top, the selected one above all.
function IncidentMarker({ incident, type, selected, onPress }) {
  const color = type?.color || colors.inkFaint;
  const critical = incident.level === "critical";
  const z = 10 + LEVEL_ORDER[incident.level] * 1000 + Math.round(incident.urgency) + (selected ? 10000 : 0);
  return (
    <Marker
      coordinate={{ latitude: incident.lat, longitude: incident.lng }}
      title={incident.type_label}
      description={"Спешност " + Math.round(incident.urgency) + " · " + (LEVEL_WORDS[incident.level] || incident.level)}
      anchor={{ x: 0.5, y: 0.5 }}
      zIndex={z}
      onPress={onPress}
    >
      <View style={[styles.incidentWrap, selected && styles.incidentSelected]}>
        <View style={[styles.incidentHalo, critical && { backgroundColor: alpha(colors.red, 0.35) }]}>
          <View style={[styles.incident, { backgroundColor: color }]} />
        </View>
      </View>
    </Marker>
  );
}

// ---------- Ticket ----------

function Pill({ label, tone }) {
  const tones = {
    green: [colors.green, colors.greenSoft],
    red: [colors.red, colors.redSoft],
    blue: [colors.blue, colors.blueSoft],
    neutral: [colors.inkSoft, "rgba(255,255,255,0.05)"],
  };
  const [color, bg] = tones[tone] || tones.neutral;
  return (
    <View style={[styles.pill, { backgroundColor: bg, borderColor: alpha(color === colors.inkSoft ? "#ffffff" : color, 0.3) }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

function Ticket({ incident, selected, changedAt, onPress }) {
  const flash = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!changedAt) return;
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 1600, useNativeDriver: false }).start();
  }, [changedAt]);

  const level = LEVEL_COLORS[incident.level] || colors.inkFaint;
  const pills = [];
  if (incident.confirmed) {
    pills.push(<Pill key="c" tone="green" label={"Потвърден от " + people(incident.reports_count - 1 + incident.witness_yes)} />);
  } else if (incident.witnesses_asked > 0) {
    pills.push(<Pill key="w" label={"Чака свидетели (" + incident.witnesses_asked + ")"} />);
  }
  if (incident.witness_no > 0) pills.push(<Pill key="n" tone="red" label={"Отхвърлен от " + people(incident.witness_no)} />);
  if (incident.has_photo) pills.push(<Pill key="p" label="Снимка" />);
  if (incident.assigned_team) pills.push(<Pill key="s" tone="blue" label={incident.status_label} />);

  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }}>
      <Animated.View
        style={[
          styles.ticket,
          { borderLeftColor: level },
          selected && styles.ticketSelected,
          { backgroundColor: flash.interpolate({ inputRange: [0, 1], outputRange: [selected ? "#221a14" : colors.surface2, "rgba(255,107,26,0.28)"] }) },
        ]}
      >
        <View style={[styles.score, { backgroundColor: alpha(level === colors.inkFaint ? "#ffffff" : level, level === colors.inkFaint ? 0.05 : 0.15) }]}>
          <Text style={[styles.scoreNumber, { color: level }]}>{Math.round(incident.urgency)}</Text>
          <Text style={[styles.scoreWord, { color: level }]}>{LEVEL_WORDS[incident.level] || incident.level}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.ticketTop}>
            <Text style={styles.ticketType} numberOfLines={1}>
              {incident.type_label}
            </Text>
            <Text style={styles.ticketTime}>{timeAgo(incident.created_at)}</Text>
          </View>
          <Text style={styles.ticketPeople}>
            {incident.people_affected > 0 ? incident.people_affected + " засегнати" : "Брой засегнати не е посочен"}
          </Text>
          {pills.length > 0 && <View style={styles.pills}>{pills}</View>}
        </View>
      </Animated.View>
    </Pressable>
  );
}

// ---------- Screen ----------

export default function OperatorScreen({ onLogout }) {
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState(null);
  const [teams, setTeams] = useState([]);
  const [meta, setMeta] = useState(null);
  const [incidents, setIncidents] = useState(new Map()); // id -> summary
  const [selectedId, setSelectedId] = useState(null);
  const [detailId, setDetailId] = useState(null); // the incident open in the detail sheet
  const [detailVersion, setDetailVersion] = useState(0); // bumped to load the detail again
  const detailIdRef = useRef(null);
  detailIdRef.current = detailId;
  const [changed, setChanged] = useState({}); // id -> time of the last live change
  const [online, setOnline] = useState(false);
  const [toast, setToast] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const socket = useRef(null);
  const mapRef = useRef(null);
  const statsRequest = useRef(0);
  const incidentsRequest = useRef(0);

  const showToast = (text, tone) => setToast({ text, tone, id: Date.now() });

  const loadStats = useCallback(async () => {
    const request = ++statsRequest.current;
    try {
      const data = await api.request("/api/stats");
      if (request === statsRequest.current) setStats(data);
    } catch (e) {
      /* The next round tries again; the connection status shows the problem. */
    }
  }, []);

  const loadTeams = useCallback(async () => {
    try {
      setTeams(await api.request("/api/teams"));
    } catch (e) {
      showToast(e.message, "error");
    }
  }, []);

  const loadIncidents = useCallback(async () => {
    const request = ++incidentsRequest.current;
    try {
      const list = await api.request("/api/incidents");
      if (request !== incidentsRequest.current) return;
      const map = new Map(list.map((i) => [i.id, i]));
      setIncidents(map);
      setSelectedId((id) => (id !== null && map.has(id) ? id : null));
    } catch (e) {
      if (request === incidentsRequest.current) showToast(e.message, "error");
    }
  }, []);

  // An incident from a live event: add or update it, or drop it once it is closed.
  const applyIncident = useCallback((incident, isNew) => {
    incidentsRequest.current++; // a list still loading is older than this event
    const closed = !OPEN_STATUSES.includes(incident.status);
    setIncidents((old) => {
      const map = new Map(old);
      if (closed) map.delete(incident.id);
      else map.set(incident.id, incident);
      return map;
    });
    if (closed) setSelectedId((id) => (id === incident.id ? null : id));
    else setChanged((old) => ({ ...old, [incident.id]: Date.now() }));
    if (incident.id === detailIdRef.current) setDetailVersion((n) => n + 1);
    if (isNew && incident.level === "critical") {
      showToast("Нов критичен сигнал: " + incident.type_label, "error");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
  }, []);

  const clearIncidents = useCallback(() => {
    incidentsRequest.current++;
    setIncidents(new Map());
    setSelectedId(null);
    setDetailId(null);
    setChanged({});
  }, []);

  useEffect(() => {
    api.loadMeta().then(setMeta).catch(() => {});
    loadStats();
    loadTeams();
    loadIncidents();
    const statsTimer = setInterval(loadStats, STATS_EVERY_MS);
    const incidentsTimer = setInterval(loadIncidents, INCIDENTS_EVERY_MS);

    socket.current = api.connect({
      onStatus: setOnline,
      // After every (re)connect: pick up what happened while offline.
      onOpen: () => {
        loadStats();
        loadTeams();
        loadIncidents();
        setDetailVersion((n) => n + 1);
      },
      onEvent: (event, data) => {
        if (event === "incident.created" || event === "incident.updated") {
          applyIncident(data, event === "incident.created");
          loadStats();
        } else if (event === "team.updated") {
          setTeams((list) => list.map((t) => (t.id === data.id ? data : t)));
          loadStats();
          setDetailVersion((n) => n + 1); // the free teams to choose from may have changed
        } else if (event === "demo.reset") {
          clearIncidents();
          loadStats();
          loadTeams();
        }
      },
    });
    return () => {
      clearInterval(statsTimer);
      clearInterval(incidentsTimer);
      statsRequest.current++;
      incidentsRequest.current++;
      if (socket.current) socket.current.close();
    };
  }, []);

  function select(incident) {
    setSelectedId(incident.id);
    setDetailId(incident.id);
    mapRef.current?.animateToRegion(
      { latitude: incident.lat, longitude: incident.lng, latitudeDelta: 0.03, longitudeDelta: 0.03 },
      400
    );
  }

  function confirmReset() {
    Alert.alert(
      "Нулиране на демото",
      "Всички сигнали, свидетелски отговори и задачи ще бъдат изтрити, а екипите ще станат свободни. Акаунтите остават. Това не може да се отмени.",
      [
        { text: "Отказ", style: "cancel" },
        {
          text: "Нулирай",
          style: "destructive",
          onPress: async () => {
            try {
              await api.request("/api/demo/reset", { method: "POST" });
              showToast("Демото е нулирано.", "success");
              clearIncidents();
              loadStats();
              loadTeams();
            } catch (e) {
              showToast(e.message, "error");
            }
          },
        },
      ]
    );
  }

  async function logout() {
    if (socket.current) socket.current.close();
    socket.current = null;
    await api.logout();
    onLogout();
  }

  async function refresh() {
    setRefreshing(true);
    await Promise.all([loadStats(), loadTeams(), loadIncidents()]);
    setRefreshing(false);
  }

  const s = stats || {};
  const v = (value) => (stats ? String(value) : "—");
  const critical = stats ? stats.critical : 0;
  const queue = sortIncidents(incidents);

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.brand}>
          <Wordmark size={19} />
          <Text style={styles.role}>Оператор 112</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.connDot, { backgroundColor: online ? colors.teal : colors.red }]} />
          <Text style={styles.connText}>{online ? "На линия" : "Няма връзка"}</Text>
          <Pressable onPress={logout} style={styles.headerBtn} hitSlop={6}>
            <Text style={styles.headerBtnText}>Изход</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.orange} colors={[colors.orange]} />}
      >
        <View style={styles.stats}>
          <Stat label="Активни" value={v(s.open)} />
          <Stat label="Критични" value={v(s.critical)} alert={critical > 0} />
          <Stat label="Потвърдени" value={v(s.confirmed)} />
          <Stat label="До потвърждение" value={stats ? formatWait(s.avg_seconds_to_confirmation) : "—"} />
          <Stat label="Свободни екипи" value={stats ? s.teams_available + "/" + s.teams_total : "—"} />
          {/* "online" counts open connections per role, e.g. {"operator": 1, "citizen": 3}. */}
          <Stat label="Граждани онлайн" value={v((s.online && s.online.citizen) || 0)} />
        </View>

        <View style={styles.mapBox}>
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialRegion={{ ...SOFIA, latitudeDelta: 0.09, longitudeDelta: 0.09 }}
            userInterfaceStyle="dark"
            customMapStyle={Platform.OS === "android" ? DARK_MAP : undefined}
            toolbarEnabled={false}
          >
            {teams.map((team) => (
              <TeamMarker key={"t" + team.id} team={team} />
            ))}
            {queue.map((incident) => (
              <IncidentMarker
                key={"i" + incident.id}
                incident={incident}
                type={meta?.byKey[incident.type]}
                selected={incident.id === selectedId}
                onPress={() => select(incident)}
              />
            ))}
          </MapView>
        </View>
        <View style={styles.legend}>
          {(meta ? meta.types : []).map((t) => (
            <View key={t.key} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: t.color }]} />
              <Text style={styles.legendText}>{t.label}</Text>
            </View>
          ))}
          <View style={styles.legendItem}>
            <View style={styles.legendTeam}>
              <Text style={styles.legendTeamText}>М</Text>
            </View>
            <Text style={styles.legendText}>Екип</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.h2}>Сигнали по спешност</Text>
            {queue.length > 0 && <Text style={text.hint}>{queue.length}</Text>}
          </View>
          {queue.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Няма активни сигнали.</Text>
              <Text style={[text.hint, { textAlign: "center" }]}>Новите ще се появят тук автоматично.</Text>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {queue.map((incident) => (
                <Ticket
                  key={incident.id}
                  incident={incident}
                  selected={incident.id === selectedId}
                  changedAt={changed[incident.id]}
                  onPress={() => select(incident)}
                />
              ))}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.detail}>
            <View style={styles.detailIcon}>
              <LineIcon {...ICONS.pin} size={26} color={colors.inkFaint} strokeWidth={1.6} />
            </View>
            <Text style={styles.detailTitle}>Изберете сигнал</Text>
            <Text style={[text.hint, { textAlign: "center", maxWidth: 280 }]}>
              Изберете сигнал от списъка или от картата, за да видите подробностите и да изпратите екип.
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Button variant="ghost" title="Нулирай демото" onPress={confirmReset} />
        </View>
      </ScrollView>

      <IncidentDetail
        incidentId={detailId}
        version={detailVersion}
        onClose={() => setDetailId(null)}
        onChanged={(summary) => {
          applyIncident(summary, false);
          loadStats();
        }}
      />

      <Toast toast={toast} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: "#0e0e10",
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  role: { paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: colors.lineStrong, color: colors.inkSoft, fontFamily: fonts.semibold, fontSize: 13 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 7 },
  connDot: { width: 8, height: 8, borderRadius: 4 },
  connText: { color: colors.inkSoft, fontFamily: fonts.medium, fontSize: 12 },
  headerBtn: { marginLeft: 4, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  headerBtnText: { color: colors.inkSoft, fontFamily: fonts.semibold, fontSize: 13 },

  stats: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 12 },
  stat: {
    flexBasis: "31.5%",
    flexGrow: 1,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  statAlert: { borderColor: "rgba(240,68,56,0.55)", backgroundColor: colors.redSoft },
  statLabel: { color: colors.inkFaint, fontFamily: fonts.semibold, fontSize: 10, letterSpacing: 0.4 },
  statValue: { fontFamily: fonts.bold, fontSize: 18, marginTop: 1, fontVariant: ["tabular-nums"] },

  mapBox: { height: 340, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line, backgroundColor: "#0d0d0f" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 6, columnGap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 12 },
  legendTeam: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.orange,
    backgroundColor: "#0b0b0c",
    alignItems: "center",
    justifyContent: "center",
  },
  legendTeamText: { color: colors.orangeBright, fontFamily: fonts.bold, fontSize: 8 },

  team: {
    width: 24,
    height: 24,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.orange,
    backgroundColor: "#0b0b0c",
    alignItems: "center",
    justifyContent: "center",
  },
  teamBusy: { borderColor: colors.inkFaint },
  teamLetter: { color: colors.orangeBright, fontFamily: fonts.bold, fontSize: 11 },

  incidentWrap: { padding: 3, borderRadius: 20, borderWidth: 3, borderColor: "transparent" },
  incidentSelected: { borderColor: colors.orange },
  incidentHalo: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  incident: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: "#fff" },

  section: { paddingHorizontal: 12, marginTop: 18 },
  sectionHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10, paddingHorizontal: 4 },
  h2: { color: colors.ink, fontFamily: fonts.bold, fontSize: 16 },
  empty: { padding: 22, borderRadius: 14, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong, alignItems: "center", gap: 6 },
  emptyTitle: { color: colors.ink, fontFamily: fonts.medium, fontSize: 15 },

  ticket: {
    flexDirection: "row",
    gap: 12,
    padding: 10,
    paddingRight: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderColor: colors.line,
  },
  ticketSelected: { borderColor: colors.orange },
  score: { width: 64, borderRadius: 9, alignItems: "center", justifyContent: "center", paddingVertical: 6 },
  scoreNumber: { fontFamily: fonts.bold, fontSize: 24, lineHeight: 26, fontVariant: ["tabular-nums"] },
  scoreWord: { fontFamily: fonts.semibold, fontSize: 11, marginTop: 2 },
  ticketTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  ticketType: { flex: 1, color: colors.ink, fontFamily: fonts.bold, fontSize: 15 },
  ticketTime: { color: colors.inkFaint, fontFamily: fonts.regular, fontSize: 12 },
  ticketPeople: { color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 13, marginTop: 2 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  pill: { paddingHorizontal: 8, paddingVertical: 1, borderRadius: 999, borderWidth: 1 },
  pillText: { fontFamily: fonts.semibold, fontSize: 12 },

  detail: {
    alignItems: "center",
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  detailIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  detailTitle: { color: colors.ink, fontFamily: fonts.bold, fontSize: 18, marginBottom: 6 },
});
