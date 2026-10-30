import type { Usage } from "@shared/types";
import type { TokenSpeed } from "@shared/metrics";
import { asRecord } from "../codex/rollout";
import { speedFromTokenEvents, type CodexTokenEvent } from "../codex/usage";
import type { OpencodeMessage } from "./transcript-events";

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/**
 * A session row's token block → the shared disjoint Usage shape. OpenCode's `reasoning` count is
 * generated output the model produced in thinking mode — it is NOT a prompt cost — so it folds into
 * outputTokens (the claude transcript's output_tokens includes reasoning too; this is the same
 * quantity under a different name). Cache reads/writes map 1:1 from `cache`; the 5-minute and
 * 1-hour cache buckets the shared Usage carries are a Claude statusline concept the v2 API does not
 * break out, so they stay 0 — the Spend panel's combined cache-write number shows cache.write.
 */
export function usageFromRow(tokens: unknown): Usage {
  const r = asRecord(tokens);
  const c = asRecord(r?.cache);
  const output = num(r?.output) + num(r?.reasoning);
  return {
    inputTokens: num(r?.input),
    outputTokens: output,
    cacheReadTokens: num(c?.read),
    cacheCreationTokens: num(c?.write),
    // Not separately reported by the v2 API (see docblock).
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
  };
}

/** Zero usage for a session whose row carries no token block (a just-spawned session). */
export const ZERO_USAGE: Usage = usageFromRow(null);

/**
 * Throughput synthesis for the Throughput panel, reusing codex's speedFromTokenEvents arithmetic
 * exactly (one definition in the repo). OpenCode reports tokens per MESSAGE snapshot rather than
 * per token_count delta, so the deltas the speed algorithm consumes are built from each assistant
 * message's `tokens` block — output+reasoning of that message over the interval since the previous
 * message. Messages carry cumulative per-SESSION counts in the session ROW, but message-level
 * `tokens` is that message's own usage (verified live), so the event falloff is honest.
 */
export function speedFromMessages(
  messages: OpencodeMessage[],
  windowMs: number,
): TokenSpeed | null {
  const events: CodexTokenEvent[] = [];
  for (const message of messages) {
    const r = asRecord(message);
    if (!r || r.type !== "assistant") continue;
    const tokens = asRecord(r.tokens);
    if (!tokens) continue;
    const time = asRecord(r.time);
    const ms =
      num(time?.completed) || num(time?.streamed) || num(time?.created);
    if (!ms) continue;
    events.push({
      tsMs: ms,
      input: num(tokens.input),
      output: num(tokens.output) + num(tokens.reasoning),
    });
  }
  // Oldest→newest, stable, without relying on the caller's fetch order.
  events.sort((a, b) => a.tsMs - b.tsMs);
  return speedFromTokenEvents(events, windowMs);
}
