// The bottom sheets of the home screen: send a report, pick a location,
// answer a witness question and the "sent" confirmation.

import { useEffect, useRef, useState } from "react";
import { Alert, Animated, Easing, Image, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";

import * as api from "./api";
import { formatDistance } from "./format";
import { alpha, colors, fonts } from "./theme";
import { Button, ICONS, LineIcon, Sheet, TypeIcon, text } from "./ui";

export const SOFIA = { latitude: 42.6977, longitude: 23.3219 };

// A dark map on Android (Google Maps). iOS follows userInterfaceStyle.
export const DARK_MAP = [
  { elementType: "geometry", stylers: [{ color: "#1a1a1d" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8a8a93" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0b0b0c" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a2a2f" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a3a40" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d1418" }] },
];

function region(point, zoomedIn) {
  const delta = zoomedIn ? 0.006 : 0.05;
  return { ...point, latitudeDelta: delta, longitudeDelta: delta };
}

function mapProps() {
  return {
    userInterfaceStyle: "dark",
    customMapStyle: Platform.OS === "android" ? DARK_MAP : undefined,
    showsUserLocation: true,
    showsMyLocationButton: false,
    toolbarEnabled: false,
  };
}

// An orange drop with a dark centre, like the web map pin.
function Pin({ color = colors.orange }) {
  return (
    <View style={styles.pinWrap}>
      <View style={[styles.pin, { backgroundColor: color }]}>
        <View style={styles.pinDot} />
      </View>
    </View>
  );
}

// ---------- Photo ----------

const PICKER_OPTIONS = {
  mediaTypes: ["images"],
  quality: 0.7,
  exif: false,
  // On iPhone this turns HEIC photos into JPEG, which the server accepts.
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

async function fromCamera() {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    Alert.alert("Няма достъп до камерата", "Разрешете камерата в настройките на телефона.");
    return null;
  }
  const result = await ImagePicker.launchCameraAsync(PICKER_OPTIONS);
  return result.canceled ? null : result.assets[0];
}

async function fromLibrary() {
  const result = await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
  return result.canceled ? null : result.assets[0];
}

function PhotoField({ photo, onChange, hint }) {
  function choose() {
    Alert.alert("Снимка", "Само от безопасно място.", [
      { text: "Камера", onPress: async () => onChange((await fromCamera()) || photo) },
      { text: "Галерия", onPress: async () => onChange((await fromLibrary()) || photo) },
      { text: "Отказ", style: "cancel" },
    ]);
  }
  return (
    <View style={styles.field}>
      <Text style={text.label}>
        Снимка <Text style={text.hint}>— {hint}</Text>
      </Text>
      {photo ? (
        <View style={styles.photoRow}>
          <Image source={{ uri: photo.uri }} style={styles.photo} />
          <View style={{ flex: 1, gap: 8 }}>
            <Button variant="ghost" title="Смени" onPress={choose} />
            <Button variant="quiet" title="Премахни" onPress={() => onChange(null)} />
          </View>
        </View>
      ) : (
        <Pressable onPress={choose} style={({ pressed }) => [styles.photoAdd, pressed && { borderColor: colors.orange }]}>
          <LineIcon {...ICONS.camera} color={colors.inkSoft} />
          <Text style={styles.photoAddText}>Добави снимка</Text>
        </Pressable>
      )}
    </View>
  );
}

// ---------- Report ----------

export function ReportSheet({ type, start, onClose, onSent }) {
  const [point, setPoint] = useState(start || SOFIA);
  const [description, setDescription] = useState("");
  const [people, setPeople] = useState(0);
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    if (sending) return;
    const data = new FormData();
    data.append("type", type.key);
    data.append("lat", point.latitude.toFixed(6));
    data.append("lng", point.longitude.toFixed(6));
    data.append("description", description.trim());
    data.append("people_affected", String(people));
    if (photo) data.append("photo", api.photoPart(photo));

    setError("");
    setSending(true);
    try {
      const result = await api.request("/api/reports", { method: "POST", form: data });
      onSent(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet visible={!!type} onClose={onClose} title={type?.label} icon={<TypeIcon type={type} size={44} />}>
      {type?.life_threatening && (
        <Pressable onPress={() => Linking.openURL("tel:112")} style={styles.danger}>
          <LineIcon {...ICONS.phone} size={18} color="#ff8178" />
          <Text style={styles.dangerText}>Ако някой е в опасност сега — обадете се на 112</Text>
        </Pressable>
      )}

      <View style={styles.field}>
        <Text style={text.label}>Къде е?</Text>
        <View style={styles.mapBox}>
          <MapView
            style={StyleSheet.absoluteFill}
            initialRegion={region(start || SOFIA, !!start)}
            onPress={(e) => setPoint(e.nativeEvent.coordinate)}
            {...mapProps()}
          >
            <Marker coordinate={point} draggable onDragEnd={(e) => setPoint(e.nativeEvent.coordinate)} anchor={{ x: 0.5, y: 1 }}>
              <Pin />
            </Marker>
          </MapView>
        </View>
        <Text style={[text.hint, { marginTop: 8 }]}>Докоснете картата или плъзнете маркера.</Text>
      </View>

      <View style={styles.field}>
        <Text style={text.label}>Какво виждате?</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          maxLength={500}
          multiline
          placeholder="Напр. „Мъж е паднал на тротоара и не отговаря“"
          placeholderTextColor={colors.inkFaint}
          selectionColor={colors.orange}
          style={styles.textarea}
        />
        <Text style={[text.hint, { alignSelf: "flex-end", fontSize: 12, marginTop: 4 }]}>{description.length}/500</Text>
      </View>

      <View style={styles.field}>
        <Text style={text.label}>Колко души са засегнати?</Text>
        <View style={styles.stepper}>
          <Pressable style={styles.stepperBtn} onPress={() => setPeople(Math.max(0, people - 1))} disabled={people === 0} accessibilityLabel="По-малко">
            <Text style={[styles.stepperSign, people === 0 && { color: colors.inkFaint }]}>−</Text>
          </Pressable>
          <Text style={styles.stepperValue}>{people}</Text>
          <Pressable style={styles.stepperBtn} onPress={() => setPeople(Math.min(100, people + 1))} disabled={people === 100} accessibilityLabel="Повече">
            <Text style={styles.stepperSign}>+</Text>
          </Pressable>
        </View>
      </View>

      <PhotoField photo={photo} onChange={setPhoto} hint="по желание" />

      {!!error && <Text style={[text.error, { marginBottom: 12 }]}>{error}</Text>}
      <Button variant="danger" title={sending ? "Изпращане…" : "Изпрати сигнала"} onPress={send} busy={sending} />
    </Sheet>
  );
}

// ---------- Location picker ----------

export function LocationSheet({ visible, start, onPick, onUseGps, onClose }) {
  const [point, setPoint] = useState(start);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const mapRef = useRef(null);

  useEffect(() => {
    if (visible) {
      setPoint(start);
      setError("");
    }
  }, [visible]);

  function pick(coordinate) {
    setPoint(coordinate);
    onPick(coordinate);
  }

  async function useGps() {
    setLocating(true);
    setError("");
    const found = await onUseGps();
    setLocating(false);
    if (found) {
      setPoint(found);
      mapRef.current?.animateToRegion(region(found, true), 400);
    } else {
      setError("GPS не е достъпен. Посочете мястото на картата.");
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Къде се намирате?" scroll={false}>
      <Text style={[text.hint, { marginBottom: 12 }]}>Докоснете картата там, където сте в момента.</Text>
      <View style={[styles.mapBox, { height: 380 }]}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialRegion={region(start || SOFIA, !!start)}
          onPress={(e) => pick(e.nativeEvent.coordinate)}
          {...mapProps()}
        >
          {point && (
            <Marker coordinate={point} anchor={{ x: 0.5, y: 1 }}>
              <Pin color={colors.blue} />
            </Marker>
          )}
        </MapView>
      </View>
      {!!error && <Text style={[text.error, { marginTop: 10 }]}>{error}</Text>}
      <View style={styles.actions}>
        <Button variant="ghost" title="Използвай GPS" onPress={useGps} busy={locating} style={{ flex: 1 }} />
        <Button title="Готово" onPress={onClose} style={{ flex: 1 }} />
      </View>
    </Sheet>
  );
}

// ---------- Witness question ----------

function formatLeft(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return m + ":" + s;
}

export function QuestionSheet({ question, type, deadline, onAnswered, onSkip }) {
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState("");
  const [answering, setAnswering] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setPhoto(null);
    setError("");
    setAnswering(null);
  }, [question?.request_id]);

  useEffect(() => {
    if (!question) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [question?.request_id]);

  async function answer(value) {
    if (answering) return;
    const data = new FormData();
    data.append("answer", value);
    if (value === "yes" && photo) data.append("photo", api.photoPart(photo));
    setError("");
    setAnswering(value);
    try {
      await api.request("/api/witness/" + question.request_id, { method: "POST", form: data });
      onAnswered(question, value, null);
    } catch (e) {
      if (e.status) onAnswered(question, value, e.message); // the server refused: move on
      else setError(e.message); // no connection: keep the question
    } finally {
      setAnswering(null);
    }
  }

  const left = deadline ? deadline - now : 0;
  const point = question ? { latitude: question.lat, longitude: question.lng } : SOFIA;

  return (
    <Sheet
      visible={!!question}
      onClose={onSkip}
      title={question ? "Сигнал на " + formatDistance(question.distance_m) + " от вас" : ""}
      icon={<TypeIcon type={type} size={44} />}
    >
      {question && (
        <>
          <Text style={styles.question}>{question.question}</Text>
          <View style={[styles.mapBox, { height: 150, marginBottom: 16 }]} pointerEvents="none">
            <MapView style={StyleSheet.absoluteFill} initialRegion={region(point, true)} scrollEnabled={false} zoomEnabled={false} {...mapProps()}>
              <Marker coordinate={point} anchor={{ x: 0.5, y: 1 }}>
                <Pin color={type?.color || colors.orange} />
              </Marker>
            </MapView>
          </View>

          <PhotoField photo={photo} onChange={setPhoto} hint="по желание, само при „Да“" />

          {!!error && <Text style={[text.error, { marginBottom: 12 }]}>{error}</Text>}

          <View style={styles.actions}>
            <Button variant="success" title="Да, виждам" onPress={() => answer("yes")} busy={answering === "yes"} disabled={!!answering} style={{ flex: 1.4 }} />
            <Button variant="ghost" title="Не" onPress={() => answer("no")} busy={answering === "no"} disabled={!!answering} style={{ flex: 1 }} />
          </View>
          <Button variant="quiet" title="Не виждам оттук" onPress={() => answer("unsure")} disabled={!!answering} style={{ marginTop: 4 }} />
          <Text style={[text.hint, styles.timer, left < 60000 && { color: colors.amber }]}>
            Можете да отговорите още {formatLeft(left)} мин.
          </Text>
        </>
      )}
    </Sheet>
  );
}

// ---------- Sent ----------

export function SentSheet({ message, onClose }) {
  const flip = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!message) return;
    flip.setValue(0);
    Animated.timing(flip, { toValue: 1, duration: 900, delay: 150, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }).start();
  }, [message]);

  return (
    <Sheet visible={!!message} onClose={onClose}>
      <View style={{ alignItems: "center", paddingTop: 8 }}>
        <Animated.View
          style={{
            opacity: flip,
            transform: [
              { perspective: 500 },
              { rotateY: flip.interpolate({ inputRange: [0, 1], outputRange: ["-200deg", "0deg"] }) },
              { scale: flip.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
            ],
          }}
        >
          <LinearGradient colors={[alpha(colors.teal, 0.4), alpha(colors.teal, 0.08)]} style={styles.check}>
            <LineIcon {...ICONS.check} size={34} strokeWidth={3} color={colors.tealBright} />
          </LinearGradient>
        </Animated.View>
        <Text style={styles.sentTitle}>Сигналът е изпратен</Text>
        <Text style={styles.sentText}>{message}</Text>
      </View>
      <Button title="Добре" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: 18 },
  mapBox: { height: 210, borderRadius: 18, overflow: "hidden", borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface2 },
  pinWrap: { width: 34, height: 40, alignItems: "center" },
  pin: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderBottomLeftRadius: 0,
    borderWidth: 2,
    borderColor: "#fff",
    transform: [{ rotate: "-45deg" }],
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.6,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  pinDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#0b0b0c" },
  danger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(240,68,56,0.4)",
    backgroundColor: colors.redSoft,
  },
  dangerText: { flex: 1, color: "#ff8178", fontFamily: fonts.semibold, fontSize: 14 },
  textarea: {
    minHeight: 92,
    padding: 14,
    paddingTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(0,0,0,0.35)",
    color: colors.ink,
    fontFamily: fonts.regular,
    fontSize: 16,
    textAlignVertical: "top",
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  stepperBtn: { width: 52, height: 46, alignItems: "center", justifyContent: "center" },
  stepperSign: { color: colors.ink, fontSize: 24, fontFamily: fonts.medium },
  stepperValue: { minWidth: 40, textAlign: "center", color: colors.ink, fontFamily: fonts.bold, fontSize: 18 },
  photoAdd: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  photoAddText: { color: colors.inkSoft, fontFamily: fonts.semibold, fontSize: 15 },
  photoRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  photo: { width: 110, height: 110, borderRadius: 14, borderWidth: 1, borderColor: colors.lineStrong },
  actions: { flexDirection: "row", gap: 10, marginTop: 14 },
  question: { color: colors.ink, fontFamily: fonts.bold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3, marginBottom: 14 },
  timer: { textAlign: "center", marginTop: 8, fontSize: 13 },
  check: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 1,
    borderColor: "rgba(46,211,183,0.5)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  sentTitle: { color: colors.ink, fontFamily: fonts.bold, fontSize: 21, marginBottom: 6 },
  sentText: { color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, textAlign: "center", marginBottom: 22 },
});
