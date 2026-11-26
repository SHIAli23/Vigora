// Shared building blocks: background lights, the 3D radar, buttons, cards, icons,
// step labels, the toast and the bottom sheet.

import { useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Circle, Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { alpha, colors, fonts, lighten } from "./theme";

// ---------- Background lights ----------

// A soft round light made from rings that get fainter toward the edge.
function Glow({ color, size, style, strength = 0.16 }) {
  const rings = [1, 0.8, 0.6, 0.42, 0.26];
  return (
    <View pointerEvents="none" style={[{ position: "absolute", width: size, height: size }, style]}>
      {rings.map((scale, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: (size * (1 - scale)) / 2,
            top: (size * (1 - scale)) / 2,
            width: size * scale,
            height: size * scale,
            borderRadius: size,
            backgroundColor: alpha(color, strength * 0.22 * (i + 1) * 0.6),
          }}
        />
      ))}
    </View>
  );
}

// Orange, teal and violet lights behind the screen. They drift slowly.
export function Backdrop() {
  const drift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: 11000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(drift, { toValue: 0, duration: 11000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [drift]);
  const move = (x, y) => ({
    transform: [
      { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [0, x] }) },
      { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, y] }) },
    ],
  });
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, move(-30, 20)]}>
        <Glow color={colors.orange} size={420} style={{ top: -180, right: -170 }} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, move(25, -15)]}>
        <Glow color={colors.teal} size={360} style={{ top: 260, left: -190 }} strength={0.1} />
        <Glow color={colors.violet} size={380} style={{ bottom: -120, right: -160 }} strength={0.1} />
      </Animated.View>
    </View>
  );
}

// ---------- Radar: rings spreading from a red dot, on a tilted plane ----------

export function Radar({ color = colors.orange, size = 160, active = true }) {
  const rings = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];
  const sweep = useRef(new Animated.Value(0)).current;
  const bob = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) return undefined;
    const ringLoops = rings.map((ring, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 1200),
          Animated.timing(ring, { toValue: 1, duration: 3600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(ring, { toValue: 0, duration: 0, useNativeDriver: true }),
          Animated.delay((2 - i) * 1200),
        ])
      )
    );
    const sweepLoop = Animated.loop(
      Animated.timing(sweep, { toValue: 1, duration: 4500, easing: Easing.linear, useNativeDriver: true })
    );
    const bobLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    [...ringLoops, sweepLoop, bobLoop].forEach((l) => l.start());
    return () => [...ringLoops, sweepLoop, bobLoop].forEach((l) => l.stop());
  }, [active]);

  const height = size * 0.58;
  const plane = {
    position: "absolute",
    left: 0,
    top: (height - size) / 2,
    width: size,
    height: size,
    transform: [{ perspective: 420 }, { rotateX: "64deg" }],
  };

  return (
    <View pointerEvents="none" style={{ width: size, height }}>
      <View style={plane}>
        <View style={[styles.radarDisc, { borderRadius: size, backgroundColor: alpha(color, 0.1) }]} />
        <View style={[styles.radarDisc, { margin: size * 0.18, borderRadius: size, borderColor: "rgba(255,255,255,0.07)" }]} />
        <View style={[styles.radarDisc, { margin: size * 0.34, borderRadius: size, borderColor: "rgba(255,255,255,0.07)" }]} />
        {active && (
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { transform: [{ rotate: sweep.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] },
            ]}
          >
            <LinearGradient
              colors={[alpha(color, 0.5), alpha(color, 0)]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0.4 }}
              style={{ position: "absolute", left: size / 2, top: 0, width: size / 2, height: size / 2, borderTopRightRadius: size / 2 }}
            />
          </Animated.View>
        )}
        {active &&
          rings.map((ring, i) => (
            <Animated.View
              key={i}
              style={[
                StyleSheet.absoluteFill,
                {
                  borderRadius: size,
                  borderWidth: 2,
                  borderColor: color,
                  opacity: ring.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 0.9, 0] }),
                  transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.12, 1] }) }],
                },
              ]}
            />
          ))}
      </View>
      {/* The red dot floats above the plane, with its shadow on the plane. */}
      <View style={[styles.radarShadow, { left: size / 2 - 9, top: height / 2 - 2 }]} />
      <Animated.View
        style={{
          position: "absolute",
          left: size / 2 - 9,
          top: height / 2 - 20,
          transform: [{ translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) }],
        }}
      >
        <View style={styles.radarHalo} />
        <LinearGradient colors={["#ff9a90", colors.red, "#9e1a12"]} start={{ x: 0.3, y: 0.2 }} end={{ x: 0.8, y: 1 }} style={styles.radarCore} />
      </Animated.View>
    </View>
  );
}

// ---------- Buttons ----------

// A pill button that sinks a little when pressed.
export function Button({ title, onPress, variant = "primary", disabled, busy, style, textStyle, icon }) {
  const press = useRef(new Animated.Value(0)).current;
  const to = (v) => Animated.spring(press, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
  const palette = BUTTONS[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      onPressIn={() => to(1)}
      onPressOut={() => to(0)}
      accessibilityRole="button"
      style={style}
    >
      <Animated.View
        style={[
          styles.button,
          palette.box,
          (disabled || busy) && { opacity: 0.55 },
          { transform: [{ translateY: press.interpolate({ inputRange: [0, 1], outputRange: [0, 2] }) }, { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] }) }] },
        ]}
      >
        {palette.gradient && (
          <LinearGradient colors={palette.gradient} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={[StyleSheet.absoluteFill, { borderRadius: 999 }]} />
        )}
        {busy ? <ActivityIndicator color={palette.text.color} /> : icon}
        <Text style={[styles.buttonText, palette.text, textStyle]}>{title}</Text>
      </Animated.View>
    </Pressable>
  );
}

const BUTTONS = {
  primary: {
    gradient: [colors.orangeBright, colors.orange, colors.orangeDeep],
    box: { shadowColor: colors.orange, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
    text: { color: "#1a0a00" },
  },
  danger: {
    gradient: ["#ff6a5e", colors.red, "#c4281c"],
    box: { shadowColor: colors.red, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
    text: { color: "#fff" },
  },
  success: {
    gradient: ["#6fe3a2", colors.green, "#25a85c"],
    box: { shadowColor: colors.green, shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
    text: { color: "#03140a" },
  },
  ghost: {
    box: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "rgba(255,255,255,0.04)" },
    text: { color: colors.ink },
  },
  quiet: {
    box: { backgroundColor: "transparent" },
    text: { color: colors.inkSoft },
  },
};

// ---------- Cards ----------

// A dark card with an orange-to-teal gradient border.
export function GlowCard({ children, style, contentStyle, borderColors }) {
  return (
    <LinearGradient
      colors={borderColors || [alpha(colors.orange, 0.75), "rgba(255,255,255,0.08)", alpha(colors.teal, 0.75)]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.glowCard, style]}
    >
      <LinearGradient colors={["#18181b", "#0e0e10"]} start={{ x: 0, y: 0 }} end={{ x: 0.3, y: 1 }} style={[styles.glowCardInner, contentStyle]}>
        {children}
      </LinearGradient>
    </LinearGradient>
  );
}

// ---------- Step labels ----------

export function StepLabel({ number, children, style }) {
  return (
    <View style={[styles.step, style]}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{number}</Text>
      </View>
      <Text style={styles.stepText}>{children.toUpperCase()}</Text>
      <LinearGradient colors={[colors.lineStrong, "transparent"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.stepLine} />
    </View>
  );
}

// ---------- Wordmark ----------

export function Wordmark({ size = 20 }) {
  return (
    <Text style={{ fontFamily: fonts.display, fontSize: size, color: colors.ink, letterSpacing: -0.5 }}>
      Vig<Text style={{ color: colors.orange }}>o</Text>ra
    </Text>
  );
}

// ---------- Icons ----------

// Line icons per incident type, the same drawings as the web app.
const TYPE_PATHS = {
  medical: ["M19.5 12.6 12 20l-7.5-7.4A4.8 4.8 0 0 1 12 6.3a4.8 4.8 0 0 1 7.5 6.3z", "M4 12h4l1.5-2.5 3 5L14 12h6"],
  fire: [
    "M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.6-2.6-5.9-4-8.8-.4 2-1.6 3.4-2.8 3.9C12 7 10.6 4.6 8.6 3c.2 3-3.1 5.6-3.1 10.3C5.5 18.2 8.2 21 12 21z",
    "M12 21c-1.7 0-3-1.2-3-3 0-2 1.5-3 2.2-4.8 1.3 1.1 3.8 2.6 3.8 4.8 0 1.8-1.3 3-3 3z",
  ],
  violence: ["M12 3 5 6v5.5c0 4.3 3 8 7 9.5 4-1.5 7-5.2 7-9.5V6z", "M12 8v4.5M12 16h.01"],
  accident: ["M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5", "M4 12h16v4.5H4z"],
  suspicious: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"],
  other: ["M8 12h.01M12 12h.01M16 12h.01"],
};
const TYPE_CIRCLES = {
  accident: [[7.5, 18, 1.5], [16.5, 18, 1.5]],
  suspicious: [[12, 12, 3]],
  other: [[12, 12, 9]],
};

export function LineIcon({ paths = [], circles = [], size = 22, color = colors.ink, strokeWidth = 1.8 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d, i) => (
        <Path key={"p" + i} d={d} strokeWidth={d.includes("h.01") ? 2.6 : strokeWidth} />
      ))}
      {circles.map(([cx, cy, r], i) => (
        <Circle key={"c" + i} cx={cx} cy={cy} r={r} />
      ))}
    </Svg>
  );
}

export const ICONS = {
  pin: { paths: ["M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"], circles: [[12, 10, 2.5]] },
  eye: { paths: TYPE_PATHS.suspicious, circles: TYPE_CIRCLES.suspicious },
  close: { paths: ["M6 6l12 12M18 6L6 18"] },
  check: { paths: ["M5 12.5l4.5 4.5L19 7.5"] },
  camera: { paths: ["M4 8h3l2-2.5h6L17 8h3v11H4z"], circles: [[12, 13, 3.5]] },
  phone: { paths: ["M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"] },
  gps: { paths: ["M12 2v3M12 19v3M2 12h3M19 12h3"], circles: [[12, 12, 7], [12, 12, 2.5]] },
};

// The rounded, tinted icon box of an incident type.
export function TypeIcon({ type, size = 46 }) {
  const color = type?.color || colors.inkFaint;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        borderWidth: 1,
        borderColor: alpha(color, 0.45),
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        shadowColor: color,
        shadowOpacity: 0.55,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 6 },
      }}
    >
      <LinearGradient colors={[alpha(color, 0.36), alpha(color, 0.08)]} start={{ x: 0, y: 0 }} end={{ x: 0.6, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={styles.iconShine} />
      <LineIcon paths={TYPE_PATHS[type?.key] || []} circles={TYPE_CIRCLES[type?.key] || []} color={lighten(color, 0.55)} size={size * 0.48} />
    </View>
  );
}

// ---------- Toast ----------

// top: the distance from the top; by default just under the header of the screen.
export function Toast({ toast, top }) {
  const shown = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!toast) return undefined;
    shown.setValue(0);
    Animated.spring(shown, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 8 }).start();
    const timer = setTimeout(() => {
      Animated.timing(shown, { toValue: 0, duration: 250, useNativeDriver: true }).start();
    }, toast.duration || 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  const tone = toast.tone === "error" ? colors.red : toast.tone === "success" ? colors.teal : colors.orange;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.toast,
        { top: top ?? insets.top + 56, borderColor: alpha(tone, 0.5) },
        { opacity: shown, transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) }] },
      ]}
    >
      <View style={[styles.toastDot, { backgroundColor: tone }]} />
      <Text style={styles.toastText}>{toast.text}</Text>
    </Animated.View>
  );
}

// ---------- Bottom sheet ----------

// overlay: shown above the content without scrolling with it, e.g. a toast.
export function Sheet({ visible, onClose, title, icon, children, scroll = true, overlay }) {
  const insets = useSafeAreaInsets();
  const Body = scroll ? ScrollView : View;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Затвори" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]}>
          <View style={styles.handle} />
          {(title || icon) && (
            <View style={styles.sheetHead}>
              {icon}
              <Text style={styles.sheetTitle} numberOfLines={2}>
                {title}
              </Text>
              <Pressable onPress={onClose} style={styles.sheetClose} accessibilityLabel="Затвори" hitSlop={8}>
                <LineIcon {...ICONS.close} size={20} strokeWidth={2.2} color={colors.inkSoft} />
              </Pressable>
            </View>
          )}
          <Body keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {children}
          </Body>
          {overlay}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------- Small text styles used across screens ----------

export const text = StyleSheet.create({
  hint: { color: colors.inkFaint, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  label: { color: colors.inkSoft, fontFamily: fonts.semibold, fontSize: 14, marginBottom: 8 },
  error: { color: "#ff8178", fontFamily: fonts.medium, fontSize: 14, lineHeight: 20 },
});

const styles = StyleSheet.create({
  radarDisc: { ...StyleSheet.absoluteFillObject, borderWidth: 1, borderColor: "rgba(255,255,255,0.09)" },
  radarShadow: { position: "absolute", width: 18, height: 6, borderRadius: 9, backgroundColor: "rgba(0,0,0,0.55)" },
  radarHalo: { position: "absolute", left: -9, top: -9, width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(240,68,56,0.22)" },
  radarCore: {
    width: 18,
    height: 18,
    borderRadius: 9,
    shadowColor: colors.red,
    shadowOpacity: 0.9,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },

  button: {
    minHeight: 52,
    paddingHorizontal: 22,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  buttonText: { fontFamily: fonts.bold, fontSize: 16 },

  glowCard: {
    borderRadius: 22,
    padding: 1,
    shadowColor: "#000",
    shadowOpacity: 0.8,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 18 },
    elevation: 10,
  },
  glowCardInner: { borderRadius: 21, padding: 18, overflow: "hidden" },

  step: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  stepNum: {
    minWidth: 32,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,107,26,0.35)",
    backgroundColor: colors.orangeSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumText: { fontFamily: fonts.display, fontSize: 10, color: colors.orangeBright },
  stepText: { fontFamily: fonts.semibold, fontSize: 12, letterSpacing: 1.4, color: colors.inkSoft },
  stepLine: { flex: 1, height: 1 },

  iconShine: { position: "absolute", top: 0, left: 6, right: 6, height: 1, backgroundColor: "rgba(255,255,255,0.3)" },

  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: "rgba(24,24,27,0.97)",
    shadowColor: "#000",
    shadowOpacity: 0.7,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  toastDot: { width: 8, height: 8, borderRadius: 4 },
  toastText: { flex: 1, color: colors.ink, fontFamily: fonts.medium, fontSize: 15 },

  sheetWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.65)" },
  sheet: {
    maxHeight: "92%",
    paddingHorizontal: 18,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.lineStrong, marginTop: 10, marginBottom: 12 },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  sheetTitle: { flex: 1, color: colors.ink, fontFamily: fonts.bold, fontSize: 20, letterSpacing: -0.3 },
  sheetClose: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
});
