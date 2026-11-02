/**
 * The Search pane's pure model (B1): the snippet mark parser the result rows render through.
 * JSX-free and React-free, so the node-config typecheck + the jsdom test suite reach it.
 *
 * Main's snippet comes from SQLite's `snippet(fts, 0, '…', '»', '«', 24)`: every matched term
 * renders wrapped as `…term»`, and larger snippets' fragments are joined with `«`. The pane
 * splits on those two markers — '…' OPENS a highlight span, '»' CLOSES it, anything outside is
 * plain text ('«' stays visible as the ellipsis between windows).
 */

const OPEN = "\u2026"; // '…' — start of a matched term (snippet arg 4)
const CLOSE = "\u00BB"; // '»' — end of a matched term (snippet arg 5)

export interface SnippetSpan {
  text: string;
  /** A matched term (the pane styles these, the plain segments stay muted). */
  hit: boolean;
}

export function splitSnippet(snippet: string): SnippetSpan[] {
  const out: SnippetSpan[] = [];
  let i = 0;
  while (i < snippet.length) {
    const openAt = snippet.indexOf(OPEN, i);
    const closeAt = snippet.indexOf(CLOSE, i);
    if (openAt === -1 || closeAt === -1 || closeAt < openAt) {
      // No further highlightable pair: the rest is plain text.
      const rest = snippet.slice(i);
      if (rest) out.push({ text: rest, hit: false });
      break;
    }
    if (openAt > i) out.push({ text: snippet.slice(i, openAt), hit: false });
    out.push({ text: snippet.slice(openAt + 1, closeAt), hit: true });
    i = closeAt + 1;
  }
  return out.length > 0 ? out : [{ text: snippet, hit: false }];
}
