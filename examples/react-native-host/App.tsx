import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Button, Linking, SafeAreaView, Text, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import { WebView } from "react-native-webview";
import { attachPaneBridge, createMemoryZecSendStore, createRampClient, createZecSendStore, type PaneBridge, type PaneBridgeHandlers, type PaneTransport } from "@0xramp/sdk";
import { createPartnerHost, type HostState } from "./host";

const PARTNER_ID = process.env.EXPO_PUBLIC_PARTNER_ID ?? "";
const SANDBOX = PARTNER_ID === "";
// Port 8082 avoids Expo Metro's default port. Android emulator: use 10.0.2.2.
const SANDBOX_URL = process.env.EXPO_PUBLIC_SANDBOX_URL ?? "http://localhost:8082/sandbox-pane.html";
// One demonstration wallet. Real hosts MUST scope both stores to the unlocked wallet.
const STORAGE_SCOPE = "ramp.example.wallet";
const secureStorage = {
  get: (key: string) => SecureStore.getItemAsync(`${STORAGE_SCOPE}.${key}`),
  set: (key: string, value: string) => SecureStore.setItemAsync(`${STORAGE_SCOPE}.${key}`, value),
};
const liveStore = createZecSendStore(secureStorage);
const demoStore = createMemoryZecSendStore();

// Deliberately fails closed. Replace with the partner's native confirmation +
// wallet adapter only after completing docs/partner-readiness.md.
const liveWallet: NonNullable<PaneBridgeHandlers["onZecSendRequest"]> = async () => ({ cancel: true, reason: "wallet adapter not configured" });

function confirmSimulation(signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    const finish = (approved: boolean) => { signal.removeEventListener("abort", abort); resolve(approved && !signal.aborted); };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    Alert.alert("Simulate a ZEC send", "Sandbox only. No funds move.", [
      { text: "Cancel", style: "cancel", onPress: () => finish(false) },
      { text: "Simulate", onPress: () => finish(true) },
    ], { cancelable: true, onDismiss: () => finish(false) });
  });
}

export default function App(): JSX.Element {
  const webRef = useRef<WebView>(null);
  const listener = useRef<((raw: unknown) => void) | undefined>(undefined);
  const host = useRef<ReturnType<typeof createPartnerHost> | undefined>(undefined);
  const demoBridge = useRef<PaneBridge | undefined>(undefined);
  const epoch = useRef(0);
  const [state, setState] = useState<HostState>({ message: "Initializing", active: false, blocked: !SANDBOX, pane: null });
  const [configurationError, setConfigurationError] = useState(false);
  const client = useRef<ReturnType<typeof createRampClient> | undefined>(undefined);
  const transport = useRef<PaneTransport>({
    post: message => {
      if (!webRef.current) throw new Error("pane detached");
      webRef.current.postMessage(JSON.stringify(message));
    },
    subscribe: handler => { listener.current = handler; return () => { if (listener.current === handler) listener.current = undefined; }; },
  }).current;

  useEffect(() => {
    if (SANDBOX) {
      try {
        const url = new URL(SANDBOX_URL);
        if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(url.hostname) || url.pathname !== "/sandbox-pane.html" || url.username || url.password) throw new Error("local sandbox required");
        setState(current => ({ ...current, message: "Sandbox ready" }));
      } catch { setConfigurationError(true); }
      return () => demoBridge.current?.close();
    }
    let mounted = true;
    try {
      const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
      const paneOrigin = process.env.EXPO_PUBLIC_PANE_ORIGIN;
      client.current = createRampClient({
        environment: apiBaseUrl ? "staging" : "production", partnerId: PARTNER_ID,
        ...(apiBaseUrl ? { apiBaseUrl } : {}), ...(paneOrigin ? { paneOrigins: [paneOrigin] } : {}), sendStore: liveStore,
      });
      const activeKey = `${STORAGE_SCOPE}.active-session`;
      const current = createPartnerHost({ client: client.current, transport, wallet: liveWallet,
        storage: { read: () => SecureStore.getItemAsync(activeKey), write: value => value === null ? SecureStore.deleteItemAsync(activeKey) : SecureStore.setItemAsync(activeKey, value) },
        onState: value => { if (mounted) setState(value); },
      });
      host.current = current;
      void current.initialize().then(async () => {
        const url = await Linking.getInitialURL();
        if (mounted && url) current.handleReturn(url);
        if (mounted) await current.refreshStatus();
      }).catch(() => { if (mounted) setConfigurationError(true); });
      const foreground = AppState.addEventListener("change", value => { if (value === "active") void current.refreshStatus(); });
      const links = Linking.addEventListener("url", event => current.handleReturn(event.url));
      return () => { mounted = false; foreground.remove(); links.remove(); current.dispose(); host.current = undefined; };
    } catch { setConfigurationError(true); return () => { mounted = false; }; }
  }, [transport]);

  function closePane() {
    demoBridge.current?.close(); demoBridge.current = undefined;
    if (SANDBOX) setState(current => ({ ...current, active: false, pane: null, message: "Sandbox closed" }));
    else host.current?.close();
  }
  function start() {
    if (!SANDBOX) {
      void host.current?.start({ direction: "sell", asset: "ZEC", fiat: "BRL", returnUrl: "ramp-example://ramp", partnerSessionId: `example-${Date.now()}-${++epoch.current}` });
      return;
    }
    closePane();
    const sessionRef = `sessSANDBOX${Date.now()}_${++epoch.current}`;
    const url = new URL(SANDBOX_URL); url.searchParams.set("sessionRef", sessionRef);
    demoBridge.current = attachPaneBridge({ sessionRef, sendStore: demoStore, transport,
      handlers: {
        onZecSendRequest: async (_request, { signal }) => await confirmSimulation(signal) ? { txid: "f".repeat(64) } : { cancel: true, reason: "simulation declined" },
        onReady: () => setState(current => ({ ...current, message: "Sandbox pane ready" })),
        onResult: () => setState(current => ({ ...current, message: "Simulated result only; no real settlement" })),
        onClose: closePane,
        onProtocolError: () => { closePane(); },
      },
    });
    setState({ message: "Opening sandbox", active: true, blocked: false, pane: { url: url.href, sessionRef, generation: epoch.current } });
  }
  function allowed(url: string) {
    if (!SANDBOX) return client.current?.isAllowedPaneUrl(url) ?? false;
    try {
      const candidate = new URL(url); const base = new URL(SANDBOX_URL);
      return candidate.origin === base.origin && candidate.pathname === base.pathname && candidate.username === "" && candidate.password === "";
    } catch { return false; }
  }
  return <SafeAreaView style={{ flex: 1, backgroundColor: "white" }}>
    <View style={{ padding: 12, gap: 8 }}>
      <Text>{SANDBOX ? "SANDBOX — no real money" : "0xramp partner example — wallet adapter disabled"}</Text>
      <Text>Powered by 0xramp · P2P.me</Text>
      <Text>{configurationError ? "Configuration unavailable. No session will be opened." : state.message}</Text>
      {state.pane && <Text selectable>{new URL(state.pane.url).origin}</Text>}
      <Button title={SANDBOX ? "Start simulation" : "Start SELL"} disabled={configurationError || (!SANDBOX && (state.active || state.blocked))} onPress={start} />
      {!SANDBOX && <Button title="Resume saved session" disabled={!state.active || state.blocked || state.pane !== null} onPress={() => { void host.current?.resume(); }} />}
      {!SANDBOX && <Button title="Check status" onPress={() => { void host.current?.refreshStatus(); }} />}
      <Button title="Close pane" onPress={closePane} />
    </View>
    {state.pane && allowed(state.pane.url) && <WebView
      key={`${state.pane.sessionRef}.${state.pane.generation}`} ref={webRef}
      source={{ uri: state.pane.url }}
      onMessage={event => { if (allowed(event.nativeEvent.url)) listener.current?.(event.nativeEvent.data); }}
      onShouldStartLoadWithRequest={request => {
        if (request.isTopFrame === false) return false;
        if (allowed(request.url)) return true;
        host.current?.handleReturn(request.url); return false;
      }}
      onError={closePane}
      // Route all navigation through the callback; never auto-open arbitrary schemes.
      originWhitelist={["*"]} setSupportMultipleWindows onOpenWindow={() => { /* Popups are refused; handoff requires an explicit host flow. */ }}
      javaScriptEnabled domStorageEnabled
      allowFileAccess={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never"
    />}
  </SafeAreaView>;
}
