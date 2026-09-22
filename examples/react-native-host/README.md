# 0xramp example host — React Native (Expo)

Two explicit modes: a local no-money simulator, or a partner session viewer
whose **live wallet adapter refuses sends until implemented**. Live API errors
never fall back to a fake payment. This is integration reference code, not a
production wallet. See [pilot gates](../../docs/partner-readiness.md).

The example links the built SDK from the repo root. Core verification does
not install or launch this example. To opt in:

```sh
# Repository root
npm ci --ignore-scripts
npm run build
npm run test:partner
python3 -m http.server 8082 --directory sandbox --bind 127.0.0.1

# Separate terminal, examples/react-native-host
npm install --ignore-scripts
npm start
```

Review any platform-specific lifecycle/build requirements separately; do not
blanket-enable install scripts. The SDK has no native build step.

Without `EXPO_PUBLIC_PARTNER_ID`, **Start simulation** opens the fixture on
loopback HTTP and requires a native confirmation before returning a fake txid.
Metro uses 8081; the sandbox uses 8082. Android emulator users set
`EXPO_PUBLIC_SANDBOX_URL=http://10.0.2.2:8082/sandbox-pane.html`. Simulator
loopback networking/cleartext rules are development settings; use issued HTTPS
origins for partner sessions. The example refuses remote sandbox URLs.

For issued partner access configure:

```text
EXPO_PUBLIC_PARTNER_ID=your-issued-partner-id
EXPO_PUBLIC_API_BASE_URL=https://issued-api-origin.example
EXPO_PUBLIC_PANE_ORIGIN=https://issued-pane-origin.example
```

Omit both origins only when onboarding has confirmed the default production
deployment. The initial source, navigation and message URL use the same client
origin policy. Popups/subframes and arbitrary external schemes are refused;
bank/browser handoff requires a separately validated host flow.

`host.ts` persists creation intent and the full session, restores tickets,
attaches before load, detaches on close and checks authoritative status on
resume, foreground, return link and advisory result. Uncertain creation and
expired sessions remain blocked for reconciliation. Secure storage and the
send journal use a fixed demonstration-wallet namespace: replace it with the
actual unlocked-wallet namespace and share one adapter object across hosts.
Never delete unresolved journal entries to restart a payment.

`app.json` registers `ramp-example://ramp`. Test custom schemes in a native
development build; Expo Go does not represent a partner's registered scheme.
Replace this route and `host.ts`'s route check together for your app.

Implement `liveWallet` using native confirmation and the real wallet core;
pass integer zatoshi, account for fees, preserve all transaction IDs and handle
abort/uncertain broadcast as described in the [partner guide](../../docs/partner-guide.md).
The opt-in tests exercise the host controller with mocks. Actual Android/iOS
builds, secure storage, passkeys and bank-app handoffs remain device tests.
