// Login and registration for citizens.

import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as api from "./api";
import { colors, fonts } from "./theme";
import { Button, Radar, Wordmark, text } from "./ui";

const DEMO = [
  ["citizen1", "Иван"],
  ["citizen2", "Мария"],
  ["citizen3", "Георги"],
  ["citizen4", "Елена"],
  ["citizen5", "Николай"],
];

function Field({ label, ...props }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={text.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.inkFaint}
        selectionColor={colors.orange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.input, focused && styles.inputFocused]}
        {...props}
      />
    </View>
  );
}

export default function LoginScreen({ onLogin }) {
  const insets = useSafeAreaInsets();
  const [registering, setRegistering] = useState(false);
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingServer, setEditingServer] = useState(false);
  const [server, setServerText] = useState(api.getServer());

  async function submit(user = username, pass = password) {
    if (busy) return;
    setError("");
    if (!user.trim() || !pass) {
      setError("Въведете потребителско име и парола.");
      return;
    }
    if (registering && fullName.trim().length < 2) {
      setError("Въведете име и фамилия.");
      return;
    }
    setBusy(true);
    try {
      await api.setServer(server);
      const result = registering
        ? await api.register(fullName.trim(), user.trim(), pass)
        : await api.login(user.trim(), pass);
      onLogin(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={[styles.page, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <View style={styles.cardLine} />
          <View style={{ alignItems: "center" }}>
            <Radar size={170} />
            <Wordmark size={32} />
            <Text style={styles.appName}>Граждани</Text>
          </View>

          {registering && (
            <Field label="Име и фамилия" value={fullName} onChangeText={setFullName} autoComplete="name" maxLength={100} />
          )}
          <Field
            label="Потребителско име"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
          />
          <Field
            label="Парола"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={registering ? "new-password" : "password"}
            onSubmitEditing={() => submit()}
            returnKeyType="go"
          />

          {!!error && <Text style={[text.error, { marginBottom: 12 }]}>{error}</Text>}

          <Button title={registering ? "Регистрация" : "Вход"} onPress={() => submit()} busy={busy} />
          <Button
            variant="quiet"
            title={registering ? "Вече имате акаунт? Вход" : "Нямате акаунт? Регистрация"}
            onPress={() => {
              setRegistering(!registering);
              setError("");
            }}
            style={{ marginTop: 6 }}
          />

          {!registering && (
            <View style={styles.demo}>
              <Text style={text.hint}>Демо акаунти. На различни телефони влезте като различни хора.</Text>
              <View style={styles.demoList}>
                {DEMO.map(([user, name]) => (
                  <Pressable
                    key={user}
                    style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.orangeSoft, borderColor: colors.orange }]}
                    onPress={() => {
                      setUsername(user);
                      setPassword("citizen123");
                      submit(user, "citizen123");
                    }}
                  >
                    <Text style={styles.chipText}>{name}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={[text.hint, { marginTop: 16 }]}>Оператор</Text>
              <View style={styles.demoList}>
                <Pressable
                  style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.orangeSoft, borderColor: colors.orange }]}
                  onPress={() => {
                    setUsername("operator");
                    setPassword("operator123");
                    submit("operator", "operator123");
                  }}
                >
                  <Text style={styles.chipText}>Оператор 112</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        {/* Where the backend runs. Found automatically, can be changed by hand. */}
        <View style={styles.server}>
          {editingServer ? (
            <TextInput
              value={server}
              onChangeText={setServerText}
              onBlur={() => setEditingServer(false)}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              selectionColor={colors.orange}
              style={[styles.input, { flex: 1 }]}
            />
          ) : (
            <Pressable onPress={() => setEditingServer(true)} hitSlop={8}>
              <Text style={text.hint}>
                Сървър: <Text style={{ color: colors.inkSoft }}>{server}</Text>  ·  <Text style={{ color: colors.orangeBright }}>промени</Text>
              </Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 16 },
  card: {
    padding: 24,
    paddingTop: 22,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(18,18,20,0.92)",
    shadowColor: "#000",
    shadowOpacity: 0.8,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 20 },
    elevation: 12,
  },
  cardLine: { position: "absolute", top: -1, left: "22%", right: "22%", height: 1, backgroundColor: "rgba(255,107,26,0.7)" },
  appName: { color: colors.inkSoft, fontFamily: fonts.regular, fontSize: 15, marginTop: 2, marginBottom: 22 },
  field: { marginBottom: 14 },
  input: {
    minHeight: 50,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(0,0,0,0.35)",
    color: colors.ink,
    fontFamily: fonts.regular,
    fontSize: 16,
  },
  inputFocused: { borderColor: colors.orange, backgroundColor: "rgba(255,107,26,0.06)" },
  demo: { marginTop: 20, paddingTop: 18, borderTopWidth: 1, borderTopColor: colors.line },
  demoList: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  chipText: { color: colors.ink, fontFamily: fonts.semibold, fontSize: 14 },
  server: { flexDirection: "row", justifyContent: "center", marginTop: 18 },
});
