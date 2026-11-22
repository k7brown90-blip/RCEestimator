/**
 * Messages page -> "Turn on notifications on this device" (work order agent-team, U7). Greyed WITH the reason when
 * the device cannot do push ("On iPhone, add RCE to the Home Screen first"), when Kyle has not set the Railway
 * variables, when the site is blocked, and for the AI admin; "Notifications on ✓ · Turn off" once on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import { NotificationsButton, PUSH_AI_ADMIN_REASON } from "./NotificationsButton";
import { api } from "../lib/api";
import { AI_ADMIN_SESSION, PIN_SESSION } from "../test/sessions";
import * as push from "../../../shared/hub/pushClient";
import { PUSH_REASONS, pushBlockedReason, type PushEnv } from "../../../shared/hub/pushClient";

afterEach(() => vi.restoreAllMocks());

const good: PushEnv = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, isIos: false, isStandalone: false, permission: "default" };
const SERVER = { configured: true, publicKey: "BKey", reason: null, subscribed: false };

function show(env: PushEnv, server: typeof SERVER = SERVER, session = PIN_SESSION, endpoint: string | null = null) {
  vi.spyOn(api, "session").mockResolvedValue(session);
  vi.spyOn(api, "hubPushKey").mockResolvedValue(server);
  vi.spyOn(push, "readPushEnv").mockReturnValue(env);
  vi.spyOn(push, "currentPushEndpoint").mockResolvedValue(endpoint);
  // "On" is THIS device's address held for THIS person, not "the person has some device".
  vi.spyOn(api, "hubPushHere").mockResolvedValue({ subscribedHere: endpoint !== null && server.subscribed });
  renderWithProviders(<NotificationsButton />);
}

describe("pushBlockedReason", () => {
  it("names the reason, in order: iPhone not on the Home Screen, an unsupported browser, the server not set up, a blocked site", () => {
    expect(pushBlockedReason({ ...good, isIos: true }, { configured: true, reason: null })).toBe(PUSH_REASONS.iosHomeScreen);
    expect(pushBlockedReason({ ...good, isIos: true, isStandalone: true }, { configured: true, reason: null })).toBeNull();
    expect(pushBlockedReason({ ...good, hasPushManager: false }, { configured: true, reason: null })).toBe(PUSH_REASONS.unsupported);
    expect(pushBlockedReason(good, { configured: false, reason: "Kyle: add the keys." })).toBe("Kyle: add the keys.");
    expect(pushBlockedReason({ ...good, permission: "denied" }, { configured: true, reason: null })).toBe(PUSH_REASONS.denied);
    expect(pushBlockedReason(good, { configured: true, reason: null })).toBeNull();
  });
});

describe("turnOffPush on a device that is someone else's", () => {
  it("leaves the browser's own subscription alone when the server says it removed nothing, and drops it when it did", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const sub = { endpoint: "https://fcm.googleapis.com/shared-pc", unsubscribe };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => sub } }) },
    });
    try {
      await push.turnOffPush(async () => ({ subscribed: false, removed: false }));
      expect(unsubscribe).not.toHaveBeenCalled();
      await push.turnOffPush(async () => ({ subscribed: false, removed: true }));
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });
});

describe("the CRM's notifications button", () => {
  it("is enabled when the device can and the server is set up", async () => {
    show(good);
    const button = await screen.findByRole("button", { name: "Turn on notifications on this device" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByTestId("notifications-reason")).not.toBeInTheDocument();
  });

  it("is greyed on an iPhone that has not added RCE to the Home Screen, with the reason beside it", async () => {
    show({ ...good, isIos: true });
    const button = await screen.findByRole("button", { name: "Turn on notifications on this device" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "On iPhone, add RCE to the Home Screen first, then open it from there.");
    expect(screen.getByTestId("notifications-reason")).toHaveTextContent("On iPhone, add RCE to the Home Screen first");
  });

  it("is greyed with the server's reason while Kyle has not set the keys", async () => {
    show(good, { configured: false, publicKey: null, reason: "Notifications are not set up on the server yet.", subscribed: false } as unknown as typeof SERVER);
    const button = await screen.findByRole("button", { name: "Turn on notifications on this device" });
    expect(button).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("notifications-reason")).toHaveTextContent("Notifications are not set up on the server yet."));
  });

  it("is greyed for the AI admin", async () => {
    show(good, SERVER, AI_ADMIN_SESSION);
    await waitFor(() => expect(screen.getByTestId("notifications-reason")).toHaveTextContent(PUSH_AI_ADMIN_REASON));
    expect(screen.getByRole("button", { name: "Turn on notifications on this device" })).toBeDisabled();
  });

  it("turns on: asks the browser, hands the subscription to the server, then reads 'Notifications on ✓' with Turn off", async () => {
    show(good);
    const subscribe = vi.spyOn(api, "hubPushSubscribe").mockResolvedValue({ subscribed: true });
    const turnOn = vi.spyOn(push, "turnOnPush").mockImplementation(async (_key, save) => {
      await save({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } });
      return "https://fcm.googleapis.com/x";
    });
    const button = await screen.findByRole("button", { name: "Turn on notifications on this device" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(turnOn).toHaveBeenCalledWith("BKey", expect.any(Function)));
    expect(subscribe).toHaveBeenCalledWith({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } });
    expect(await screen.findByText("Notifications on ✓")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeEnabled();
  });

  it("does not say 'on' for a device the server no longer holds for this person, even when they have another device on", async () => {
    // Kyle's phone is subscribed (subscribed: true), but this desktop's address was dropped (410) or moved to someone else.
    show(good, { ...SERVER, subscribed: true }, PIN_SESSION, "https://fcm.googleapis.com/desktop");
    vi.spyOn(api, "hubPushHere").mockResolvedValue({ subscribedHere: false });
    const button = await screen.findByRole("button", { name: "Turn on notifications on this device" });
    await waitFor(() => expect(api.hubPushHere).toHaveBeenCalledWith("https://fcm.googleapis.com/desktop"));
    expect(button).toBeInTheDocument();
    expect(screen.queryByText("Notifications on ✓")).not.toBeInTheDocument();
  });

  it("turns off from the same place", async () => {
    show(good, { ...SERVER, subscribed: true }, PIN_SESSION, "https://fcm.googleapis.com/x");
    const off = vi.spyOn(push, "turnOffPush").mockImplementation(async (remove) => { await remove("https://fcm.googleapis.com/x"); });
    const unsub = vi.spyOn(api, "hubPushUnsubscribe").mockResolvedValue({ subscribed: false, removed: true });
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(off).toHaveBeenCalled());
    expect(unsub).toHaveBeenCalledWith("https://fcm.googleapis.com/x");
    expect(await screen.findByRole("button", { name: "Turn on notifications on this device" })).toBeInTheDocument();
  });
});
