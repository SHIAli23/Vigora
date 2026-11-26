// Vigora for citizens: the phone app. Runs in Expo Go against the same backend as the web apps.

import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Onest_400Regular, Onest_500Medium, Onest_600SemiBold, Onest_700Bold, useFonts } from "@expo-google-fonts/onest";
import { Unbounded_600SemiBold } from "@expo-google-fonts/unbounded";

import * as api from "./src/api";
import HomeScreen from "./src/HomeScreen";
import LoginScreen from "./src/LoginScreen";
import OperatorScreen from "./src/OperatorScreen";
import { colors } from "./src/theme";
import { Backdrop } from "./src/ui";

export default function App() {
  const [fontsLoaded] = useFonts({
    Onest_400Regular,
    Onest_500Medium,
    Onest_600SemiBold,
    Onest_700Bold,
    Unbounded_600SemiBold,
  });
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(null);

  useEffect(() => {
    api.loadStored().then((stored) => {
      setSession(stored);
      setReady(true);
    });
    // An expired login sends the citizen back to the login screen.
    api.setOnExpired(() => setSession(null));
  }, []);

  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="light" />
        <Backdrop />
        {!fontsLoaded || !ready ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.orange} size="large" />
          </View>
        ) : session && session.user.role === "operator" ? (
          <OperatorScreen key={session.user.id} onLogout={() => setSession(null)} />
        ) : session ? (
          <HomeScreen key={session.user.id} session={session} onLogout={() => setSession(null)} />
        ) : (
          <LoginScreen onLogin={setSession} />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
