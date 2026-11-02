/**
 * The PDF tab kind's pure rules (pass I-b) under jsdom: name routing (pdf → the viewer status,
 * never a text read), the pdf read verdict landing, the read-only matrix (a pdf tab has no
 * dirty draft, no preview, and read-only reason "pdf"), and the file-URL builder's encoding.
 * The webview DOM itself is not testable (no component harness); the boot check covers it.
 */
import { describe, expect, it } from "vitest";
import {
  applyRead,
  canPreview,
  isDirty,
  isPdfName,
  newEditorTab,
  pdfLocalUrlOf,
  readOnlyReason,
  tabIdOf,
  type EditorOrigin,
} from "../../src/renderer/src/shell/editor/editor-model";

const localOrigin = (path: string): EditorOrigin => ({ kind: "local", path });
const serverOrigin = (path: string): EditorOrigin => ({
  kind: "server",
  serverId: "srv-acme",
  serverName: "Acme",
  path,
  opencode: false,
});

describe("tab-kind routing by name", () => {
  it(".pdf routes by name in any case (the kind is the file, not the tool)", () => {
    expect(isPdfName("spec.pdf")).toBe(true);
    expect(isPdfName("SPEC.PDF")).toBe(true);
    expect(isPdfName("spec.md")).toBe(false);
    expect(isPdfName("spec.pdff")).toBe(false);
  });

  it("identity is unchanged by the kind: same path → same tab id", () => {
    expect(tabIdOf(localOrigin("/tmp/code.pdf"))).toBe("local:/tmp/code.pdf");
    expect(tabIdOf(serverOrigin("/srv/code.pdf"))).toBe(
      "srv:srv-acme:/srv/code.pdf",
    );
  });

  it("a pdf read verdict lands status pdf + the webview url, not a text draft", () => {
    const tab = applyRead(newEditorTab(localOrigin("/tmp/code.pdf")), {
      ok: true,
      kind: "pdf",
      url: "file:///tmp/code.pdf",
      bytes: 42,
    });
    expect(tab.status).toBe("pdf");
    expect(tab.pdfUrl).toBe("file:///tmp/code.pdf");
    expect(tab.bytes).toBe(42);
  });

  it("a pdf verdict replaced by a text read clears the url (and vice versa)", () => {
    let tab = applyRead(newEditorTab(localOrigin("/tmp/notes.txt")), {
      ok: true,
      kind: "pdf",
      url: "file:///tmp/notes.pdf",
      bytes: 1,
    });
    tab = applyRead(tab, {
      ok: true,
      kind: "text",
      content: "hello",
      bytes: 5,
      capped: false,
    });
    expect(tab.status).toBe("ready");
    expect(tab.pdfUrl).toBeNull();

    tab = applyRead(tab, {
      ok: true,
      kind: "pdf",
      url: "file:///x.pdf",
      bytes: 2,
    });
    expect(tab.status).toBe("pdf");
  });

  it("a failed read beats the pdf state as anywhere else", () => {
    const tab = applyRead(newEditorTab(localOrigin("/tmp/missing.pdf")), {
      ok: false,
      message: "File not found.",
    });
    expect(tab.status).toBe("error");
    expect(tab.pdfUrl).toBeNull();
  });
});

describe("the pdf read-only matrix", () => {
  const pdfTab = applyRead(newEditorTab(localOrigin("/tmp/code.pdf")), {
    ok: true,
    kind: "pdf",
    url: "file:///tmp/code.pdf",
    bytes: 42,
  });
  it("never dirty (there is no draft to break)", () => {
    expect(isDirty(pdfTab)).toBe(false);
  });
  it("never previewable (markdown-only affordance)", () => {
    expect(canPreview(pdfTab)).toBe(false);
    expect(readOnlyReason(pdfTab)).toBe("pdf");
  });
  it("setMode stays put at edit (canPreview's own guard)", () => {
    expect(pdfTab.mode).toBe("edit");
  });
});

describe("pdfLocalUrlOf", () => {
  it("builds the browser-safe file URL, encoding spaces and question marks per segment", () => {
    expect(pdfLocalUrlOf("/home/mary/my docs/file.pdf")).toBe(
      "file:///home/mary/my%20docs/file.pdf",
    );
    expect(pdfLocalUrlOf("/tmp/a#b?c$d.pdf")).toBe(
      "file:///tmp/a%23b%3Fc$d.pdf",
    );
  });
  it("normalizes Windows backslashes to the file scheme's forward slashes", () => {
    expect(pdfLocalUrlOf("C:\\Users\\mary\\file.pdf")).toBe(
      "file:///C:/Users/mary/file.pdf",
    );
  });
});
