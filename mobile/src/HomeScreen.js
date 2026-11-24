// The citizen's home: send a report, help as a witness and follow the status of own reports.

import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import * as SecureStore from "expo-secure-store";

import * as api from "./api";
import { formatDistance, people, timeAgo, toDate } from "./format";
import { LocationSheet, QuestionSheet, ReportSheet, SentSheet } from "./sheets";
import { alpha, colors, fonts } from "./theme";
import { Button, GlowCard, ICONS, LineIcon, Radar, StepLabel, Toast, TypeIcon, Wordmark, text } from "./ui";

const WITNESS_KEY = "vigora.citizen.witness";
const SHARE_EVERY_MS = 60000;

// ---------- Type tile: a physical key that sinks when pressed ----------

function TypeTile({ type, index, onPress }) {
  const press = useRef(new Animated.Value(0)).current;
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 520,
      delay: 60 * index,
      easing: Easing.out(Easing.back(1.2)),
      useNativeDriver: true,
    }).start();
  }, []);

  const to = (v) => Animated.spring(press, { toValue: v, useNativeDriver: true, speed: 50, bounciness: 8 }).start();

  return (
    <Animated.View
      style={[
        styles.tileWrap,
        {
          opacity: enter,
          transform: [
            { perspective: 800 },
            { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
            { rotateX: enter.interpolate({ inputRange: [0, 1], outputRange: ["-24deg", "0deg"] }) },
          ],
        },
      ]}
    >
      {/* The thick edge of the key, under the face. */}
      <View style={[styles.tileEdge, { borderColor: alpha(type.color, 0.25) }]} />
      <Pressable
        onPress={onPress}
        onPressIn={() => {
          to(1);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }}
        onPressOut={() => to(0)}
        accessibilityRole="button"
        accessibilityLabel={type.label}
      >
        <Animated.View
          style={[
            styles.tile,
            {
              borderColor: alpha(type.color, 0.22),
              transform: [
                { perspective: 600 },
                { translateY: press.interpolate({ inputRange: [0, 1], outputRange: [0, 6] }) },
                { rotateX: press.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "8deg"] }) },
              ],
            },
          ]}
        >
          <LinearGradient colors={["#1d1d21", "#111113"]} style={StyleSheet.absoluteFill} />
          <LinearGradient
            colors={[alpha(type.color, 0.2), alpha(type.color, 0)]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.7, y: 0.7 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.tileShine} />
          <View style={styles.tileTop}>
            <TypeIcon type={type} />
            {type.life_threatening && (
              <View style={styles.urgent}>
                <View style={styles.urgentDot} />
                <Text style={styles.urgentText}>спешно</Text>
              </View>
            )}
          </View>
          <Text style={styles.tileLabel}>{type.label}</Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

// ---------- Report card with a progress track ----------

const TRACK = ["new", "assigned", "accepted", "on_scene", "resolved"];

function Track({ status }) {
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0, duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const stopped = status === "false_report";
  const reached = stopped ? 0 : TRACK.indexOf(status);
  return (
    <View style={styles.track}>
      {TRACK.map((key, i) => {
        const resolved = status === "resolved";
        const done = i < reached || (resolved && i === reached);
        const current = !stopped && !resolved && i === reached;
        let color = "rgba(255,255,255,0.08)";
        if (done) color = resolved && i === TRACK.length - 1 ? colors.green : colors.orange;
        if (stopped && i === 0) color = colors.red;
        return (
          <View key={key} style={[styles.trackStep, { backgroundColor: color }]}>
            {current && (
              <Animated.View
                style={[StyleSheet.absoluteFill, { borderRadius: 2, backgroundColor: "#ffd0b0", opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }]}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

function pillColors(status) {
  if (status === "resolved") return [colors.green, colors.greenSoft];
  if (status === "false_report") return [colors.red, colors.redSoft];
  return [colors.blue, colors.blueSoft];
}

function ReportCard({ report, type, highlight }) {
  const flash = useRef(new Animated.Value(highlight ? 1 : 0)).current;
  useEffect(() => {
    if (highlight) {
      flash.setValue(1);
      Animated.timing(flash, { toValue: 0, duration: 1600, useNativeDriver: false }).start();
    }
  }, [highlight]);

  const [pill, pillBg] = pillColors(report.status);
  let meta = timeAgo(report.created_at);
  if (report.confirmations > 0) meta += ", потвърден от " + people(report.confirmations);

  return (
    <Animated.View
      style={[
        styles.report,
        { borderColor: flash.interpolate({ inputRange: [0, 1], outputRange: [colors.line, colors.orange] }) },
      ]}
    >
      <View style={[styles.reportBar, { backgroundColor: type?.color || colors.inkFaint }]} />
      <View style={styles.reportTop}>
        <Text style={styles.reportType}>{report.type_label}</Text>
        <View style={[styles.pill, { backgroundColor: pillBg, borderColor: alpha(pill, 0.4) }]}>
          <Text style={[styles.pillText, { color: pill }]}>{report.status_label}</Text>
        </View>
      </View>
      {!!report.description && <Text style={styles.reportDesc}>{report.description}</Text>}
      <Track status={report.status} />
      <Text style={styles.reportMeta}>{meta}</Text>
    </Animated.View>
  );
}

// ---------- Home ----------

export default function HomeScreen({ session, onLogout }) {
  const insets = useSafeAreaInsets();
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState("");
  const [online, setOnline] = useState(false);
  const [toast, setToast] = useState(null);

  // Location: from the GPS, or picked on the map for witness mode.
  const [gps, setGps] = useState(null);
  const [gpsState, setGpsState] = useState({ state: "pending", text: "Търсим…", chip: "GPS" });
  const [manual, setManual] = useState(null);

  // Sheets
  const [reportType, setReportType] = useState(null);
  const [reportOpenCount, setReportOpenCount] = useState(0); // a fresh form for every report
  const [sentText, setSentText] = useState(null);
  const [pickingLocation, setPickingLocation] = useState(false);

  // My reports
  const [reports, setReports] = useState(null);
  const [reportsError, setReportsError] = useState("");
  const [highlightId, setHighlightId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Witness mode and questions
  const [witnessOn, setWitnessOn] = useState(false);
  const [question, setQuestion] = useState(null);
  const queue = useRef([]);
  const seen = useRef(new Set());

  const socket = useRef(null);
  const state = useRef({});
  state.current = { gps, manual, witnessOn, question };

  const showToast = (text, tone) => setToast({ text, tone, id: Date.now() });
  const currentLocation = () => state.current.manual || state.current.gps;

  // ---------- GPS ----------

  const locate = useCallback(async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setGpsState({ state: "off", text: "Посочете мястото на картата", chip: "GPS изключен" });
        return null;
      }
      if (!state.current.gps) setGpsState({ state: "pending", text: "Търсим…", chip: "GPS" });
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      const accuracy = Math.round(position.coords.accuracy || 0);
      setGps(point);
      setGpsState({
        state: "found",
        text: "Определено" + (accuracy ? " · ±" + formatDistance(accuracy) : ""),
        chip: "GPS включен",
      });
      return point;
    } catch (e) {
      if (!state.current.gps) setGpsState({ state: "off", text: "Посочете мястото на картата", chip: "GPS изключен" });
      return null;
    }
  }, []);

  // ---------- Data ----------

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await api.loadMeta());
      setMetaError("");
    } catch (e) {
      setMetaError(e.message);
    }
  }, []);

  const listRequest = useRef(0);
  const loadReports = useCallback(async (highlight) => {
    const request = ++listRequest.current;
    try {
      const data = await api.request("/api/reports/mine");
      if (request !== listRequest.current) return;
      setReports(data);
      setReportsError("");
      setHighlightId(highlight || null);
    } catch (e) {
      if (request === listRequest.current) setReportsError(e.message);
    }
  }, []);

  // ---------- Witness questions ----------

  function deadlineOf(q) {
    return toDate(q.asked_at).getTime() + q.expires_in_min * 60000;
  }

  function showNext() {
    const now = Date.now();
    queue.current = queue.current.filter((q) => deadlineOf(q) > now);
    setQuestion(queue.current.shift() || null);
  }

  function enqueue(q, isNew) {
    if (seen.current.has(q.request_id) || deadlineOf(q) <= Date.now()) return;
    seen.current.add(q.request_id);
    queue.current.push(q);
    if (isNew) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    if (!state.current.question) showNext();
  }

  async function loadPending() {
    try {
      const pending = await api.request("/api/witness/pending");
      pending.reverse().forEach((q) => enqueue(q, false)); // the server sends newest first
    } catch (e) {
      /* tried again on the next connect */
    }
  }

  // A question that runs out of time closes by itself.
  useEffect(() => {
    if (!question) return undefined;
    const timer = setTimeout(showNext, Math.max(0, deadlineOf(question) - Date.now()));
    return () => clearTimeout(timer);
  }, [question]);

  function answered(q, value, error) {
    if (error) showToast(error, "error");
    else showToast(value === "yes" ? "Благодарим! Потвърждението е изпратено." : "Благодарим за отговора.", "success");
    showNext();
  }

  // ---------- Sharing the location in witness mode ----------

  function shareLocation() {
    const point = currentLocation();
    if (!state.current.witnessOn || !point || !socket.current) return;
    socket.current.send({ type: "location", lat: point.latitude, lng: point.longitude });
  }

  useEffect(() => {
    shareLocation();
  }, [gps, manual, witnessOn]);

  useEffect(() => {
    if (!witnessOn) return undefined;
    // Refresh the GPS and send it again every minute while witness mode is on.
    const timer = setInterval(async () => {
      if (!state.current.manual) await locate();
      shareLocation();
    }, SHARE_EVERY_MS);
    return () => clearInterval(timer);
  }, [witnessOn]);

  async function setWitness(on) {
    setWitnessOn(on);
    state.current.witnessOn = on;
    SecureStore.setItemAsync(WITNESS_KEY, on ? "on" : "off").catch(() => {});
    if (on) {
      if (!currentLocation()) {
        const found = await locate();
        if (!found) setPickingLocation(true);
      }
      shareLocation();
    } else if (socket.current) {
      socket.current.send({ type: "location_off" });
    }
  }

  // ---------- Start ----------

  useEffect(() => {
    loadMeta();
    loadReports();
    locate();
    SecureStore.getItemAsync(WITNESS_KEY)
      .then((value) => {
        if (value === "on") {
          setWitnessOn(true);
          state.current.witnessOn = true;
        }
      })
      .catch(() => {});

    socket.current = api.connect({
      onStatus: setOnline,
      onOpen: () => {
        shareLocation();
        loadPending();
        loadReports();
      },
      onEvent: (event, data) => {
        if (event === "report.status") {
          showToast("Вашият сигнал: " + data.status_label);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          loadReports(data.incident_id);
        } else if (event === "witness.question") {
          enqueue(data, true);
        }
      },
    });
    return () => socket.current && socket.current.close();
  }, []);

  async function logout() {
    if (socket.current) {
      socket.current.send({ type: "location_off" });
      socket.current.close();
      socket.current = null;
    }
    await api.logout();
    onLogout();
  }

  async function refresh() {
    setRefreshing(true);
    await Promise.all([loadReports(), meta ? null : loadMeta(), locate()]);
    setRefreshing(false);
  }

  function sentMessage(result) {
    if (result.merged) {
      return "Други хора вече са съобщили за това. Вашият сигнал е добавен като потвърждение и вдига спешността му.";
    }
    if (result.witnesses_asked > 0) {
      return "Операторът на 112 го вижда. Попитахме " + people(result.witnesses_asked) + " наблизо дали го потвърждават.";
    }
    return "Операторът на 112 го вижда. Ще ви уведомим, когато екип поеме случая.";
  }

  // ---------- Render ----------

  const firstName = (session.user.full_name || "").trim().split(/\s+/)[0];
  const radarColor = gpsState.state === "found" ? colors.teal : colors.amber;
  const chipTone =
    gpsState.state === "found" ? [colors.tealBright, colors.tealSoft] : gpsState.state === "off" ? [colors.amber, colors.amberSoft] : [colors.inkSoft, "rgba(255,255,255,0.04)"];
  const witnessPoint = currentLocation();
  const types = meta ? meta.types : [];

  return (
    <View style={{ flex: 1 }}>
      {/* Emergency call bar: red is for emergencies only. */}
      <Pressable onPress={() => Linking.openURL("tel:112")} style={{ paddingTop: insets.top, backgroundColor: "#d92d20" }}>
        <LinearGradient colors={["#d92d20", colors.red, "#d92d20"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.callBar}>
          <Text style={styles.callText}>При опасност за живота се обадете</Text>
          <View style={styles.callPill}>
            <Text style={styles.callPillText}>112</Text>
          </View>
        </LinearGradient>
      </Pressable>

      <View style={styles.header}>
        <Wordmark size={19} />
        <View style={styles.headerRight}>
          <View style={[styles.connDot, { backgroundColor: online ? colors.teal : colors.inkFaint }]} />
          <Text style={styles.connText}>{online ? "На линия" : "Свързване…"}</Text>
          <Pressable onPress={logout} style={styles.logout} hitSlop={6}>
            <Text style={styles.logoutText}>Изход</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.main, { paddingBottom: insets.bottom + 40 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.orange} colors={[colors.orange]} />}
      >
        <Text style={styles.greeting}>
          {firstName ? "Здравейте, " : "Здравейте. "}
          {!!firstName && <Text style={{ color: colors.orange }}>{firstName}</Text>}
          {firstName ? ". " : ""}Какво се случва?
        </Text>

        {/* Location status, with a small radar. */}
        <GlowCard style={{ marginBottom: 28 }}>
          <View style={styles.statusRadar}>
            <Radar size={120} color={radarColor} active={gpsState.state !== "off"} />
          </View>
          <View style={styles.statusRow}>
            <View style={[styles.statusIcon, gpsState.state === "found" && { borderColor: alpha(colors.teal, 0.45), backgroundColor: alpha(colors.teal, 0.16) }]}>
              <LineIcon {...ICONS.pin} color={gpsState.state === "found" ? colors.tealBright : colors.inkSoft} />
            </View>
            <View style={{ flex: 1, paddingRight: 70 }}>
              <Text style={styles.statusSmall}>Вашето местоположение</Text>
              <Text style={styles.statusText}>{gpsState.text}</Text>
            </View>
          </View>
          <View style={styles.statusFoot}>
            <View style={[styles.chip, { borderColor: alpha(chipTone[0] === colors.inkSoft ? "#ffffff" : chipTone[0], 0.35), backgroundColor: chipTone[1] }]}>
              <Text style={[styles.chipText, { color: chipTone[0] }]}>{gpsState.chip}</Text>
            </View>
            <View style={[styles.chip, { borderColor: "rgba(255,107,26,0.35)", backgroundColor: colors.orangeSoft }]}>
              <Text style={[styles.chipText, { color: colors.orangeBright }]}>Директно към 112</Text>
            </View>
          </View>
        </GlowCard>

        <StepLabel number="01">Подайте сигнал</StepLabel>
        <Text style={[text.hint, styles.lead]}>Изберете вида на сигнала. Ще го видят операторите на 112 веднага.</Text>

        {!!metaError && (
          <View style={{ gap: 10, marginBottom: 12 }}>
            <Text style={text.error}>{metaError}</Text>
            <Button variant="ghost" title="Опитай пак" onPress={loadMeta} />
          </View>
        )}
        <View style={styles.grid}>
          {types.map((type, i) => (
            <TypeTile
              key={type.key}
              type={type}
              index={i}
              onPress={() => {
                setReportOpenCount((n) => n + 1);
                setReportType(type);
              }}
            />
          ))}
        </View>

        <StepLabel number="02" style={{ marginTop: 34 }}>
          Помогнете наблизо
        </StepLabel>
        <View style={[styles.witness, witnessOn && styles.witnessOn]}>
          <LinearGradient
            colors={[alpha(colors.blue, 0.18), "rgba(16,18,23,0)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.8, y: 0.8 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.witnessHead}>
            <View style={styles.witnessIcon}>
              <LineIcon {...ICONS.eye} size={20} color="#a8c8ff" />
            </View>
            <Text style={styles.witnessTitle}>Помагам като свидетел</Text>
            <Switch
              value={witnessOn}
              onValueChange={setWitness}
              trackColor={{ false: "#2a2a2f", true: colors.blue }}
              thumbColor="#ffffff"
              ios_backgroundColor="#2a2a2f"
              accessibilityLabel="Помагам като свидетел"
            />
          </View>
          <Text style={styles.witnessText}>
            Когато наблизо има нов сигнал, ще ви попитаме дали виждате нещо. Пазим само приблизителна зона и я
            забравяме, когато затворите приложението.
          </Text>
          <View style={styles.witnessFoot}>
            <Text style={[text.hint, { flex: 1 }]}>
              Местоположение:{" "}
              <Text style={{ color: witnessPoint ? "#a8c8ff" : colors.ink, fontFamily: fonts.semibold }}>
                {manual ? "избрано на картата" : gps ? "по GPS" : "още не е определено"}
              </Text>
            </Text>
            <Button variant="ghost" title="Избери на картата" onPress={() => setPickingLocation(true)} textStyle={{ fontSize: 14 }} style={{ marginTop: 10 }} />
          </View>
        </View>

        <StepLabel number="03" style={{ marginTop: 34 }}>
          Следете статуса
        </StepLabel>
        <View style={styles.sectionTitle}>
          <Text style={styles.h2}>Моите сигнали</Text>
          {!!reports?.length && <Text style={text.hint}>{reports.length}</Text>}
        </View>
        {!!reportsError && <Text style={text.error}>{reportsError}</Text>}
        {reports === null && !reportsError && <Text style={text.hint}>Зареждане…</Text>}
        {reports && reports.length === 0 && (
          <View style={styles.empty}>
            <Text style={[text.hint, { textAlign: "center" }]}>Още нямате подадени сигнали.</Text>
          </View>
        )}
        <View style={{ gap: 10 }}>
          {(reports || []).map((report) => (
            <ReportCard key={report.id} report={report} type={meta?.byKey[report.type]} highlight={report.incident_id === highlightId} />
          ))}
        </View>
      </ScrollView>

      <ReportSheet
        key={reportOpenCount}
        type={reportType}
        start={currentLocation()}
        onClose={() => setReportType(null)}
        onSent={(result) => {
          setReportType(null);
          setSentText(sentMessage(result));
          loadReports();
        }}
      />
      <SentSheet message={sentText} onClose={() => setSentText(null)} />
      <LocationSheet
        visible={pickingLocation}
        start={currentLocation()}
        onPick={(point) => setManual(point)}
        onUseGps={async () => {
          setManual(null);
          return locate();
        }}
        onClose={() => setPickingLocation(false)}
      />
      <QuestionSheet
        question={question}
        type={question && meta ? meta.byKey[question.type] : null}
        deadline={question ? deadlineOf(question) : 0}
        onAnswered={answered}
        onSkip={showNext}
      />

      <Toast toast={toast} />
    </View>
  );
}

const styles = StyleSheet.create({
  callBar: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, minHeight: 46, paddingHorizontal: 16, paddingVertical: 8 },
  callText: { color: "#fff", fontFamily: fonts.semibold, fontSize: 15, flexShrink: 1 },
  callPill: { paddingHorizontal: 12, paddingVertical: 1, borderRadius: 999, backgroundColor: "#fff" },
  callPillText: { color: colors.red, fontFamily: fonts.bold, fontSize: 16 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: "rgba(12,12,14,0.9)",
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  connDot: { width: 8, height: 8, borderRadius: 4 },
  connText: { color: colors.inkSoft, fontFamily: fonts.medium, fontSize: 13 },
  logout: { marginLeft: 4, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.line },
  logoutText: { color: colors.inkSoft, fontFamily: fonts.semibold, fontSize: 14 },

  main: { paddingHorizontal: 16, paddingTop: 28 },
  greeting: { color: colors.ink, fontFamily: fonts.semibold, fontSize: 30, lineHeight: 33, letterSpacing: -1, marginBottom: 18 },
  lead: { fontSize: 15, color: colors.inkSoft, marginBottom: 16 },

  statusRadar: { position: "absolute", top: -2, right: -10 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  statusIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "#1f1f23",
    alignItems: "center",
    justifyContent: "center",
  },
  statusSmall: { color: colors.inkFaint, fontFamily: fonts.regular, fontSize: 13 },
  statusText: { color: colors.ink, fontFamily: fonts.semibold, fontSize: 17 },
  statusFoot: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16 },
  chip: { paddingHorizontal: 11, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  chipText: { fontFamily: fonts.medium, fontSize: 12 },

  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 16 },
  tileWrap: { width: "48%" },
  tileEdge: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 7,
    bottom: -7,
    borderRadius: 20,
    borderWidth: 1,
    backgroundColor: "#0c0c0e",
    shadowColor: "#000",
    shadowOpacity: 0.85,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  tile: { minHeight: 140, padding: 16, borderRadius: 20, borderWidth: 1, overflow: "hidden", justifyContent: "space-between" },
  tileShine: { position: "absolute", top: 0, left: 14, right: 14, height: 1, backgroundColor: "rgba(255,255,255,0.12)" },
  tileTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  tileLabel: { color: colors.ink, fontFamily: fonts.semibold, fontSize: 16, lineHeight: 20, marginTop: 24 },
  urgent: { flexDirection: "row", alignItems: "center", gap: 5 },
  urgentDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.red },
  urgentText: { color: "#ff7a70", fontFamily: fonts.semibold, fontSize: 12 },

  witness: {
    padding: 18,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(91,155,255,0.3)",
    backgroundColor: "#11141b",
    overflow: "hidden",
  },
  witnessOn: { borderColor: "rgba(91,155,255,0.7)", shadowColor: colors.blue, shadowOpacity: 0.45, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
  witnessHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  witnessIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(91,155,255,0.4)",
    backgroundColor: "rgba(91,155,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  witnessTitle: { flex: 1, color: colors.ink, fontFamily: fonts.bold, fontSize: 18, letterSpacing: -0.3 },
  witnessText: { color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, marginTop: 12, marginBottom: 14 },
  witnessFoot: { paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },

  sectionTitle: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 },
  h2: { color: colors.ink, fontFamily: fonts.bold, fontSize: 22, letterSpacing: -0.6 },
  empty: { padding: 22, borderRadius: 16, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong },

  report: {
    paddingVertical: 14,
    paddingRight: 16,
    paddingLeft: 20,
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: "#151517",
    shadowColor: "#000",
    shadowOpacity: 0.6,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  reportBar: { position: "absolute", left: 0, top: 14, bottom: 14, width: 3, borderTopRightRadius: 3, borderBottomRightRadius: 3 },
  reportTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  reportType: { flex: 1, color: colors.ink, fontFamily: fonts.semibold, fontSize: 16 },
  pill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  pillText: { fontFamily: fonts.semibold, fontSize: 12 },
  reportDesc: { color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, marginTop: 6 },
  track: { flexDirection: "row", gap: 4, marginTop: 12 },
  trackStep: { flex: 1, height: 4, borderRadius: 2, overflow: "hidden" },
  reportMeta: { color: colors.inkFaint, fontFamily: fonts.regular, fontSize: 13, marginTop: 8 },
});
