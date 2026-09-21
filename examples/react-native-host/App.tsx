/**
 * Minimal React Native host for the 0xramp SDK (PSP-v1).
 *
 * Demonstrates the full host integration:
 * - createSession → sessionUrl;
 * - WebView pane with navigation locked to 0xramp origins;
 * - a PaneTransport adapter over WebView postMessage;
 * - onZecSendRequest → your wallet core signs (stubbed here);
 * - advisory result handling + attribution.
 *
 * Default session URL points at the repo's sandbox pane served over the
 * metro dev server; pass a real sessionUrl from createSession for pilots.
 */
import { useMemo, useRef, useState } from "react";
import { SafeAreaView, StatusBar, Text, TouchableOpacity, View } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";

import {
  ALLOWED_PANE_HOST_SUFFIXES,
  attachPaneBridge,
  createRampClient,
  isAllowedPaneNavigation,
  type PaneBridge,
  type PaneTransport,
} from "@0xramp/sdk";

const SANDBOX_PANE_URL = "http://localhost:8081/sandbox-pane.html"; // serve sandbox/ via any static server
const REAL_PANE_URL = process.env.EXPO_PUBLIC_PANE_URL ?? SANDBOX_PANE_URL;

export default function App(): JSX.Element {
  const webRef = useRef<WebView>(null);
  const bridgeRef = useRef<PaneBridge | null>(null);
  const listenerRef = useRef<(raw: unknown) => void>();
  const [status, setStatus] = useState("idle");
  const [lastResult, setLastResult] = useState<string>("");

  const transport: PaneTransport = useMemo(
    () => ({
      post: (message) => {
        webRef.current?.postMessage(JSON.stringify(message));
      },
      subscribe: (handler) => {
        listenerRef.current = handler;
        return () => {
          listenerRef.current = undefined;
        };
      },
    }),
    [],
  );

  const attach = () => {
    if (bridgeRef.current) return;
    bridgeRef.current = attachPaneBridge({
      transport,
      handlers: {
        onReady: () => setStatus("pane ready"),
        onZecSendRequest: async ({ requestId, address, amountZat }) => {
          // Real hosts: native confirm sheet → wallet core (e.g. zingolib)
          // signs the ZEC send → broadcast → return the txid.
          const approved = true; // replace with your confirm UI
          if (!approved) return { cancel: true, reason: "user declined" };
          const txid = "f".repeat(64); // stub — replace with real broadcast result
          setLastResult(`send ${amountZat} zat → ${address} (req ${requestId})`);
          return { txid };
        },
        onResult: (r) => {
          setLastResult(`advisory result: ${r.outcome} — reconcile via getStatus()`);
          setStatus(`result: ${r.outcome}`);
        },
        onClose: () => setStatus("pane closed"),
      },
    });
    setStatus("bridge attached");
  };

  const onMessage = (event: WebViewMessageEvent) => {
    listenerRef.current?.(event.nativeEvent.data);
  };

  // Origin lock: only 0xramp origins (https) may load inside the pane.
  const onShouldStartLoadWithRequest = (request: WebViewNavigation): boolean => {
    const allowed = isAllowedPaneNavigation(request.url, ALLOWED_PANE_HOST_SUFFIXES);
    if (!allowed && !request.url.startsWith(SANDBOX_PANE_URL)) {
      setStatus(`origin lock: blocked ${request.url.slice(0, 48)}…`);
      return false;
    }
    return true;
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
      <StatusBar barStyle="dark-content" />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12 }}>
        <TouchableOpacity onPress={attach}>
          <Text style={{ color: "#1d4ed8", fontWeight: "600" }}>Attach bridge</Text>
        </TouchableOpacity>
        <Text style={{ color: "#374151", fontSize: 12 }}>{status}</Text>
        <Text style={{ color: "#6b7280", fontSize: 11, marginLeft: "auto" }}>
          Powered by 0xramp · P2P.me
        </Text>
      </View>
      {lastResult === "" ? null : (
        <Text style={{ color: "#047857", fontSize: 11, paddingHorizontal: 12, paddingBottom: 8 }}>
          {lastResult}
        </Text>
      )}
      <WebView
        ref={webRef}
        source={{ uri: REAL_PANE_URL }}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        originWhitelist={["https://*", "http://localhost:*"]}
        javaScriptEnabled
        domStorageEnabled={false}
      />
    </SafeAreaView>
  );
}
