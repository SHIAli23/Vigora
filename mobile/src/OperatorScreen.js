// Operator 112 on the phone: the same panel as the web, stacked. Live stats, the map with
// the teams, the incident queue (filled in later) and the detail area.

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Animated, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MapView, { Marker } from "react-native-maps";

import * as api from "./api";
import { DARK_MAP, SOFIA } from "./sheets";
import { colors, fonts } from "./theme";
import { Button, ICONS, LineIcon, Toast, Wordmark, text } from "./ui";

const STATS_EVERY_MS = 15000;
const TEAM_LETTERS = { medical: "М", fire: "П", police: "Р" };

// Seconds as "45 с" or "3 мин"; "—" when there is nothing to measure yet.
function formatWait(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return seconds + " с";
  return Math.round(seconds / 60) + " мин";
}

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

// A team on the map: a square with a letter, orange when free, grey when busy.
function TeamMarker({ team }) {
  const busy = team.status !== "available";
  const letter = TEAM_LETTERS[team.kind] || (team.name || "?").charAt(0).toUpperCase();
  return (
    <Marker
      coordinate={{ latitude: team.lat, longitude: team.lng }}
      title={team.name}
      description={busy ? "зает" : "свободен"}
      anchor={{ x: 0.5, y: 0.5 }}
    >
      <View style={[styles.team, busy && styles.teamBusy]}>
        <Text style={[styles.teamLetter, busy && { color: colors.inkFaint }]}>{letter}</Text>
      </View>
    </Marker>
  );
}

export default function OperatorScreen({ onLogout }) {
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState(null);
  const [teams, setTeams] = useState([]);
  const [meta, setMeta] = useState(null);
  const [online, setOnline] = useState(false);
  const [toast, setToast] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const socket = useRef(null);
  const statsRequest = useRef(0);

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

  useEffect(() => {
    api.loadMeta().then(setMeta).catch(() => {});
    loadStats();
    loadTeams();
    const timer = setInterval(loadStats, STATS_EVERY_MS);

    socket.current = api.connect({
      onStatus: setOnline,
      onOpen: () => {
        loadStats();
        loadTeams();
      },
      onEvent: (event, data) => {
        if (event === "team.updated") {
          setTeams((list) => list.map((t) => (t.id === data.id ? data : t)));
          loadStats();
        } else if (event === "incident.created" || event === "incident.updated") {
          loadStats();
        } else if (event === "demo.reset") {
          loadStats();
          loadTeams();
        }
      },
    });
    return () => {
      clearInterval(timer);
      statsRequest.current++;
      if (socket.current) socket.current.close();
    };
  }, []);

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
    await Promise.all([loadStats(), loadTeams()]);
    setRefreshing(false);
  }

  const s = stats || {};
  const v = (value) => (stats ? String(value) : "—");
  const critical = stats ? stats.critical : 0;

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
            style={StyleSheet.absoluteFill}
            initialRegion={{ ...SOFIA, latitudeDelta: 0.09, longitudeDelta: 0.09 }}
            userInterfaceStyle="dark"
            customMapStyle={Platform.OS === "android" ? DARK_MAP : undefined}
            toolbarEnabled={false}
          >
            {teams.map((team) => (
              <TeamMarker key={team.id} team={team} />
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
          <Text style={styles.h2}>Сигнали по спешност</Text>
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Няма активни сигнали.</Text>
            <Text style={[text.hint, { textAlign: "center" }]}>Новите сигнали ще се появят тук, подредени по спешност.</Text>
          </View>
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

  mapBox: { height: 360, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line, backgroundColor: "#0d0d0f" },
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

  section: { paddingHorizontal: 16, marginTop: 18 },
  h2: { color: colors.ink, fontFamily: fonts.bold, fontSize: 16, marginBottom: 10 },
  empty: { padding: 22, borderRadius: 14, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong, alignItems: "center", gap: 6 },
  emptyTitle: { color: colors.ink, fontFamily: fonts.medium, fontSize: 15 },
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
