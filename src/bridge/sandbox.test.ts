import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parsePaneToHostMessage } from "../protocol/schema.js";

const html = readFileSync(new URL("../../sandbox/sandbox-pane.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("sandbox script missing");
interface Event { data?: unknown; source?: unknown; pspHandled?: boolean }
class Element {
  textContent = ""; className = ""; disabled = false;
  children: Element[] = [];
  listeners = new Map<string, (event: Event) => void>();
  addEventListener(type: string, handler: (event: Event) => void) { this.listeners.set(type, handler); }
  appendChild(child: Element) { this.children.push(child); }
  click() { if (!this.disabled) this.listeners.get("click")?.({}); }
}
function pane(native: boolean) {
  const nodes = new Map<string, Element>();
  const documentEvents = new Map<string, (event: Event) => void>();
  const windowEvents = new Map<string, (event: Event) => void>();
  const sent: unknown[] = [];
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const parent = { postMessage: (value: unknown) => { sent.push(value); } };
  const window = { parent, ...(native ? { ReactNativeWebView: { postMessage: (value: string) => { sent.push(JSON.parse(value)); } } } : {}), addEventListener: (type: string, handler: (event: Event) => void) => windowEvents.set(type, handler) };
  runInNewContext(script!, { window, document: { getElementById: node, createElement: () => new Element(), addEventListener: (type: string, handler: (event: Event) => void) => documentEvents.set(type, handler) }, location: { search: "" }, URLSearchParams, Date });
  return { sent, node, receive: (target: "window" | "document", data: unknown) => (target === "window" ? windowEvents : documentEvents).get("message")?.({ data, source: native ? null : parent }), log: () => node("log").children.map(line => line.textContent).join("\n") };
}
describe("sandbox pane transports", () => {
  it.each([false, true])("emits valid PSP fixtures through the %s native channel", native => {
    const p = pane(native); p.node("btn-send").click();
    expect(p.sent).toHaveLength(2);
    expect(p.sent.every(value => parsePaneToHostMessage(value).ok)).toBe(true);
  });
  it.each(["window", "document"] as const)("accepts React Native string replies on %s and blocks repeated sends", target => {
    const p = pane(true); p.node("btn-send").click();
    p.receive(target, JSON.stringify({ v: 1, type: "psp/zec-send-result", sessionRef: "sessSANDBOX00000001", payload: { requestId: "reqSANDBOX00000001", txid: "a".repeat(64) } }));
    expect(p.log()).toContain("←"); expect(p.log()).not.toContain("✕"); p.node("btn-send").click(); expect(p.sent).toHaveLength(2);
  });
  it("shows reconciliation for pending and rejects foreign request replies", () => {
    const p = pane(false); p.node("btn-send").click();
    const reply = { v: 1, type: "psp/zec-send-pending", sessionRef: "sessSANDBOX00000001", payload: { requestId: "reqSANDBOX00000001", reason: "broadcast-unknown" } };
    p.receive("window", reply); expect(p.log()).toContain("Do not send again");
    p.receive("window", { ...reply, payload: { ...reply.payload, requestId: "reqOTHER000000000" } }); expect(p.log()).toContain("requestId mismatch");
  });
});
