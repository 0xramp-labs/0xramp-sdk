/**
 * Pane transport abstraction (PSP-v1 channel 3).
 *
 * The host supplies a transport over the platform's messaging primitive:
 * - React Native: `WebView.postMessage` / `onMessage` (see examples/react-native-host);
 * - Electron: `webContents.executeJavaScript` / `ipcRenderer` (see examples/electron-host);
 * - Browser/tests: `window.parent.postMessage` / `message` events.
 *
 * Raw inbound values may be strings (RN) or structured values (IPC/DOM);
 * the bridge normalizes both and fails closed on garbage.
 */
export interface PaneTransport {
  /** Deliver an outbound value to the pane. Must be JSON-serializable. */
  post(message: unknown): void;
  /** Subscribe to raw inbound values. Returns an unsubscribe function. */
  subscribe(handler: (raw: unknown) => void): () => void;
}
