import { describe, expect, it } from "vitest";
import { AGENTS } from "@shared/agents";
import {
  canShowComposer,
  composerDisabledReason,
  sendGuard,
} from "../../src/renderer/src/workspace/chat-composer-model";

// The real registry flags — the composer gates on canPrompt exactly like the prompt
// queue does (never on the agent id). opencode is the one prompt-capable agent today.
const promptCaps = AGENTS.opencode.capabilities; // canPrompt: true
const cliCaps = AGENTS.claude.capabilities; // canPrompt: false

describe("chat composer gating (tier-1 Run 2 / A4)", () => {
  describe("canShowComposer (the show matrix)", () => {
    it("shows for a prompt-capable agent while idle", () => {
      expect(canShowComposer(promptCaps, "idle")).toBe(true);
    });

    it("shows for a prompt-capable agent while waiting", () => {
      expect(canShowComposer(promptCaps, "waiting")).toBe(true);
    });

    it("still shows for a prompt-capable agent while working (disabled, not hidden)", () => {
      expect(canShowComposer(promptCaps, "working")).toBe(true);
    });

    it("never shows for a prompt-capable agent once ended", () => {
      expect(canShowComposer(promptCaps, "ended")).toBe(false);
    });

    it("never shows for an agent without the canPrompt flag, even idle", () => {
      expect(canShowComposer(cliCaps, "idle")).toBe(false);
      expect(canShowComposer(cliCaps, "waiting")).toBe(false);
    });

    it("never shows for a flag-less agent while working either", () => {
      expect(canShowComposer(cliCaps, "working")).toBe(false);
    });
  });

  describe("composerDisabledReason (the disable matrix)", () => {
    it("reports busy while a prompt-capable session works", () => {
      expect(composerDisabledReason(promptCaps, "working")).toBe("busy");
    });

    it("reports nothing (sendable) while idle", () => {
      expect(composerDisabledReason(promptCaps, "idle")).toBeNull();
    });

    it("reports nothing (sendable) while waiting — the queue's own sendable state", () => {
      expect(composerDisabledReason(promptCaps, "waiting")).toBeNull();
    });

    it("reports ended for a prompt-capable ended session (the hidden defensive branch)", () => {
      expect(composerDisabledReason(promptCaps, "ended")).toBe("ended");
    });

    it("reports ended for a flag-less agent regardless of state", () => {
      expect(composerDisabledReason(cliCaps, "working")).toBe("ended");
      expect(composerDisabledReason(cliCaps, "ended")).toBe("ended");
    });
  });

  describe("sendGuard (empty text never sends)", () => {
    it("rejects empty text", () => {
      expect(sendGuard("")).toEqual({ ok: false, reason: "empty" });
    });

    it("rejects whitespace-only text", () => {
      expect(sendGuard("   ")).toEqual({ ok: false, reason: "empty" });
    });

    it("rejects newline- and tab-only text", () => {
      expect(sendGuard("\n\t \n")).toEqual({ ok: false, reason: "empty" });
    });

    it("accepts plain text", () => {
      expect(sendGuard("ship it")).toEqual({ ok: true });
    });

    it("accepts text merely surrounded by whitespace", () => {
      expect(sendGuard("  ship it  ")).toEqual({ ok: true });
    });
  });
});
