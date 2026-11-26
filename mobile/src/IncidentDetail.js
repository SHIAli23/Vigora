// The selected incident for the operator on the phone: urgency, witnesses, teams to send,
// reports, photos, actions and history. Shown as a bottom sheet.

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import * as api from "./api";
import { formatDistance, toDate } from "./format";
import { alpha, colors, fonts } from "./theme";
import { Button, Sheet, Toast, text } from "./ui";

const OPEN_STATUSES = ["new", "assigned", "accepted", "on_scene"];
const LEVEL_WORDS = { critical: "критичен", high: "висок", medium: "среден", low: "нисък" };
const LEVEL_COLORS = { critical: colors.red, high: colors.amber, medium: colors.blue, low: colors.inkFaint };

function clock(value) {
  const date = toDate(value);
  return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

// A photo from the server; the endpoint needs the login, so the token goes in the headers.
function photoSource(name) {
  const session = api.getSession();
  return {
    uri: api.getServer() + "/api/photos/" + encodeURIComponent(name),
    headers: session ? { Authorization: "Bearer " + session.access_token } : {},
  };
}

// incidentId: the incident to show, or null. version: changes when the incident or a team
// changed, so the detail loads again. onChanged(summary): after an action.
export default function IncidentDetail({ incidentId, version, onClose, onChanged }) {
  const [toast, setToast] = useState(null);
  const showToast = (text, tone) => setToast({ text, tone, id: Date.now() });
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    if (incidentId === null) return;
    const mine = ++request.current;
    try {
      const data = await api.request("/api/incidents/" + incidentId);
      if (mine !== request.current) return;
      setDetail(data);
      setError("");
    } catch (e) {
      if (mine !== request.current) return;
      if (e.status === 404) onClose(); // deleted, e.g. by a demo reset
      else setError(e.message);
    }
  }, [incidentId]);

  useEffect(() => {
    if (incidentId === null) {
      request.current++;
      setDetail(null);
      return;
    }
    if (!detail || detail.id !== incidentId) setDetail(null);
    load();
  }, [incidentId, version]);

  async function run(path, body, doneText) {
    if (busy) return;
    setBusy(true);
    try {
      const summary = await api.request("/api/incidents/" + incidentId + path, { method: "POST", json: body || {} });
      showToast(doneText, "success");
      onChanged(summary);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setBusy(false);
      load();
    }
  }

  function confirmFalse() {
    Alert.alert("Фалшив сигнал?", "Доверието към подателите ще намалее.", [
      { text: "Отказ", style: "cancel" },
      { text: "Фалшив сигнал", style: "destructive", onPress: () => run("/false", null, "Сигналът е отбелязан като фалшив.") },
    ]);
  }

  const d = detail;
  const open = d && OPEN_STATUSES.includes(d.status);
  const level = d ? LEVEL_COLORS[d.level] || colors.inkFaint : colors.inkFaint;
  const levelBg = d && d.level !== "low" ? alpha(level, 0.15) : "rgba(255,255,255,0.05)";

  let content = null;
  if (error) {
    content = <Text style={text.error}>{error}</Text>;
  } else if (!d) {
    content = <Text style={text.hint}>Зареждане…</Text>;
  } else {
    const waiting = Math.max(0, d.witnesses_asked - d.witness_yes - d.witness_no - d.witness_unsure);
    const canAssign = d.status === "new" || d.status === "assigned";
    const photos = d.reports.map((r) => r.photo).filter(Boolean).concat(d.witness_photos || []);
    const others = d.reports_count - 1;

    content = (
      <>
        {/* Header */}
        <View style={[styles.head, { borderLeftColor: level }]}>
          <View style={[styles.score, { backgroundColor: levelBg }]}>
            <Text style={[styles.scoreNumber, { color: level }]}>{Math.round(d.urgency)}</Text>
            <Text style={[styles.scoreWord, { color: level }]}>{LEVEL_WORDS[d.level] || d.level}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{d.type_label}</Text>
            <Text style={styles.subtitle}>
              {d.status_label}
              {d.assigned_team ? ": " + d.assigned_team.name : ""}. Получен в {clock(d.created_at)}.
            </Text>
          </View>
        </View>

        <Section title="Защо е с тази спешност">
          {(d.urgency_breakdown || []).map((item, i) => (
            <View key={i} style={styles.row}>
              <Text style={styles.rowLabel}>{item.label}</Text>
              <Text style={[styles.rowNum, item.points < 0 && { color: "#ff7a70" }]}>
                {item.points < 0 ? "−" + Math.abs(item.points) : "+" + item.points}
              </Text>
            </View>
          ))}
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <Text style={[styles.rowLabel, { color: colors.ink, fontFamily: fonts.bold }]}>Общо</Text>
            <Text style={styles.rowNum}>{Math.round(d.urgency)}</Text>
          </View>
        </Section>

        <Section title="Свидетели наблизо">
          {d.witnesses_asked ? (
            <>
              <View style={styles.bar}>
                {[
                  [d.witness_yes, colors.green],
                  [d.witness_no, colors.red],
                  [d.witness_unsure, "#8a8a93"],
                  [waiting, "rgba(255,255,255,0.1)"],
                ].map(([n, color], i) => (n ? <View key={i} style={{ flex: n, backgroundColor: color }} /> : null))}
              </View>
              <Text style={styles.counts}>
                Да: <Text style={styles.countNum}>{d.witness_yes}</Text>   Не: <Text style={styles.countNum}>{d.witness_no}</Text>   Не виждат:{" "}
                <Text style={styles.countNum}>{d.witness_unsure}</Text>   Чакат: <Text style={styles.countNum}>{waiting}</Text>
              </Text>
            </>
          ) : (
            <Text style={text.hint}>Нямаше хора наблизо, споделили местоположение.</Text>
          )}
          {others > 0 && (
            <Text style={[styles.body, { marginTop: 10 }]}>
              {others === 1 ? "Още 1 човек е подал" : "Още " + others + " души са подали"} отделен сигнал за същото място.
            </Text>
          )}
        </Section>

        {open && (
          <Section title="Екипи">
            {(d.team_candidates || []).length === 0 ? (
              <Text style={text.hint}>Няма свободен подходящ екип в момента.</Text>
            ) : (
              d.team_candidates.map((team, i) => (
                <View key={team.id} style={[styles.candidate, i === 0 && styles.preferred]}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.candidateTop}>
                      <Text style={styles.candidateName}>{team.name}</Text>
                      {i === 0 && (
                        <View style={styles.recommended}>
                          <Text style={styles.recommendedText}>Препоръчан</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.small}>
                      {team.kind_label} · {formatDistance(team.distance_m)} · около {team.eta_min} мин
                    </Text>
                  </View>
                  <Button
                    title="Изпрати"
                    variant={i === 0 ? "primary" : "ghost"}
                    disabled={!canAssign || busy}
                    onPress={() => run("/assign", { team_id: team.id }, "Изпратен екип: " + team.name)}
                    style={{ minWidth: 96 }}
                    textStyle={{ fontSize: 14 }}
                  />
                </View>
              ))
            )}
          </Section>
        )}

        <Section title={"Сигнали от граждани (" + d.reports.length + ")"}>
          {d.reports.map((r) => (
            <View key={r.id} style={styles.report}>
              <Text style={[styles.body, !r.description && { color: colors.inkFaint, fontStyle: "italic" }]}>
                {r.description || "Без описание"}
              </Text>
              <Text style={styles.small}>
                {clock(r.created_at)} · {r.people_affected > 0 ? r.people_affected + " засегнати" : "Брой засегнати не е посочен"} ·
                доверие на подателя: {Math.round(r.reporter_trust)}/100
              </Text>
            </View>
          ))}
        </Section>

        {photos.length > 0 && (
          <Section title="Снимки">
            <View style={styles.photos}>
              {photos.map((name) => (
                <Pressable key={name} onPress={() => setPhoto(name)} style={styles.photo} accessibilityLabel="Отвори снимката">
                  <Image source={photoSource(name)} style={StyleSheet.absoluteFill} resizeMode="cover" />
                </Pressable>
              ))}
            </View>
          </Section>
        )}

        {open && (
          <View style={[styles.section, styles.actions]}>
            <Button title="Приключи" onPress={() => run("/resolve", null, "Сигналът е приключен.")} disabled={busy} style={{ flex: 1 }} />
            <Button
              title="Фалшив сигнал"
              variant="ghost"
              onPress={confirmFalse}
              disabled={busy}
              style={{ flex: 1 }}
              textStyle={{ color: "#ff7a70" }}
            />
          </View>
        )}

        <Section title="История">
          {d.events.map((e, i) => (
            <View key={i} style={styles.event}>
              <Text style={styles.eventTime}>{clock(e.created_at)}</Text>
              <Text style={[styles.small, { flex: 1, color: colors.inkSoft, fontSize: 13 }]}>{e.text}</Text>
            </View>
          ))}
        </Section>
      </>
    );
  }

  return (
    // The toast of the screen is hidden under the sheet, so the sheet has its own.
    <Sheet visible={incidentId !== null} onClose={onClose} title="Сигнал" overlay={<Toast toast={toast} top={8} />}>
      {content}
      {/* A photo full screen, inside the sheet so it opens above it on iPhone too. A tap closes it. */}
      <Modal visible={!!photo} transparent animationType="fade" onRequestClose={() => setPhoto(null)} statusBarTranslucent>
        <Pressable style={styles.viewer} onPress={() => setPhoto(null)} accessibilityLabel="Затвори снимката">
          {photo && <Image source={photoSource(photo)} style={styles.viewerImage} resizeMode="contain" />}
        </Pressable>
      </Modal>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 14, paddingLeft: 12, borderLeftWidth: 4, marginBottom: 6 },
  score: { width: 78, paddingVertical: 9, borderRadius: 10, alignItems: "center" },
  scoreNumber: { fontFamily: fonts.bold, fontSize: 32, lineHeight: 34, fontVariant: ["tabular-nums"] },
  scoreWord: { fontFamily: fonts.semibold, fontSize: 11, marginTop: 2 },
  title: { color: colors.ink, fontFamily: fonts.bold, fontSize: 20 },
  subtitle: { color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 13, marginTop: 3, lineHeight: 18 },

  section: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
  sectionTitle: { color: colors.inkSoft, fontFamily: fonts.bold, fontSize: 12, letterSpacing: 0.7, marginBottom: 10 },
  body: { color: colors.ink, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  small: { color: colors.inkFaint, fontFamily: fonts.regular, fontSize: 12, marginTop: 3, lineHeight: 17 },

  row: { flexDirection: "row", justifyContent: "space-between", gap: 10, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.line },
  rowLabel: { flex: 1, color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 14 },
  rowNum: { color: colors.ink, fontFamily: fonts.semibold, fontSize: 14, fontVariant: ["tabular-nums"] },

  bar: { flexDirection: "row", height: 10, borderRadius: 5, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.06)" },
  counts: { color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 13, marginTop: 8 },
  countNum: { color: colors.ink, fontFamily: fonts.bold },

  candidate: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    marginBottom: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
  },
  preferred: { borderColor: "rgba(255,107,26,0.5)", backgroundColor: "#1f1712" },
  candidateTop: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  candidateName: { color: colors.ink, fontFamily: fonts.bold, fontSize: 14 },
  recommended: { paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,107,26,0.35)", backgroundColor: colors.orangeSoft },
  recommendedText: { color: colors.orangeBright, fontFamily: fonts.semibold, fontSize: 11 },

  report: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line },

  photos: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  photo: { width: "31.8%", aspectRatio: 1, borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface2 },

  actions: { flexDirection: "row", gap: 8 },

  event: { flexDirection: "row", gap: 10, paddingVertical: 3 },
  eventTime: { color: colors.inkFaint, fontFamily: fonts.medium, fontSize: 13, fontVariant: ["tabular-nums"] },

  viewer: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.94)", padding: 16 },
  viewerImage: { width: "100%", height: "100%" },
});
