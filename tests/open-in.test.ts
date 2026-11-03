import { describe, it, expect, vi } from "vitest";
import {
  isProjectWithinKnownDirs,
  openInTarget,
  revealProjectFolder,
  revealSessionTranscript,
  vscodeUrl,
} from "../src/main/open-in";
import type { OpenInTarget } from "../src/shared/ipc";

function makeShell() {
  return {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve("")),
    showItemInFolder: vi.fn(),
  };
}

describe("vscodeUrl", () => {
  it("builds an encoded vscode://file URL for an absolute path", () => {
    expect(vscodeUrl("/Users/foo/my project")).toBe(
      "vscode://file/Users/foo/my%20project",
    );
  });

  it("normalizes a Windows path and keeps the drive letter colon raw", () => {
    expect(vscodeUrl("C:\\Users\\foo\\my project")).toBe(
      "vscode://file/C:/Users/foo/my%20project",
    );
  });

  it("is independent of host OS for either path style", () => {
    // pathToFileURL would resolve this drive-less path against the current drive on Windows;
    // vscodeUrl must not, so the result is the same regardless of where the process runs.
    expect(vscodeUrl("/Users/foo/proj")).toBe("vscode://file/Users/foo/proj");
  });
});

describe("openInTarget", () => {
  const resolveOk = () => "/Users/foo/proj";
  const isDir = () => true;

  it("opens Finder via openPath and reports ok", async () => {
    const shell = makeShell();
    const res = await openInTarget(
      { resolveCwd: resolveOk, statDir: isDir, shell },
      "s1",
      "finder",
    );
    expect(shell.openPath).toHaveBeenCalledWith("/Users/foo/proj");
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  it("opens VSCode via openExternal with the vscode URL", async () => {
    const shell = makeShell();
    const res = await openInTarget(
      { resolveCwd: () => "/Users/foo/my project", statDir: isDir, shell },
      "s1",
      "vscode",
    );
    expect(shell.openExternal).toHaveBeenCalledWith(
      "vscode://file/Users/foo/my%20project",
    );
    expect(res).toEqual({ ok: true });
  });

  it("fails without calling shell when no cwd resolves", async () => {
    const shell = makeShell();
    const res = await openInTarget(
      { resolveCwd: () => null, statDir: isDir, shell },
      "s1",
      "finder",
    );
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it("fails without calling shell when no cwd resolves (vscode target)", async () => {
    const shell = makeShell();
    const res = await openInTarget(
      { resolveCwd: () => null, statDir: isDir, shell },
      "s1",
      "vscode",
    );
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it("fails without calling shell when the path is not a directory", async () => {
    const shell = makeShell();
    const res = await openInTarget(
      { resolveCwd: resolveOk, statDir: () => false, shell },
      "s1",
      "vscode",
    );
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it("surfaces openPath's non-empty error string", async () => {
    const shell = makeShell();
    shell.openPath = vi.fn(() => Promise.resolve("Failed to open path"));
    const res = await openInTarget(
      { resolveCwd: resolveOk, statDir: isDir, shell },
      "s1",
      "finder",
    );
    expect(res).toEqual({ ok: false, error: "Failed to open path" });
  });

  it("fails for an unknown target without opening anything", async () => {
    const shell = makeShell();
    const res = await openInTarget(
      { resolveCwd: resolveOk, statDir: isDir, shell },
      "s1",
      "explorer" as unknown as OpenInTarget,
    );
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it("surfaces a thrown shell error as a failure (vscode target)", async () => {
    const shell = makeShell();
    shell.openExternal = vi.fn(() => Promise.reject(new Error("no handler")));
    const res = await openInTarget(
      { resolveCwd: resolveOk, statDir: isDir, shell },
      "s1",
      "vscode",
    );
    expect(res).toEqual({ ok: false, error: "no handler" });
  });
});

describe("revealProjectFolder", () => {
  const known = () => true;
  const isDir = () => true;

  it("opens a known, existing project folder in the OS file manager", async () => {
    const shell = makeShell();
    const res = await revealProjectFolder(
      { isKnownProject: known, statDir: isDir, shell },
      "/Users/foo/proj",
    );
    expect(shell.openPath).toHaveBeenCalledWith("/Users/foo/proj");
    expect(res).toEqual({ ok: true });
  });

  it("refuses a path the session index doesn't know, without touching shell", async () => {
    const shell = makeShell();
    const res = await revealProjectFolder(
      { isKnownProject: () => false, statDir: isDir, shell },
      "/etc",
    );
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: "Unknown project." });
  });

  it("refuses malformed cwd values from the renderer", async () => {
    const shell = makeShell();
    for (const bad of ["", 42, null, undefined, {}]) {
      const res = await revealProjectFolder(
        { isKnownProject: known, statDir: isDir, shell },
        bad,
      );
      expect(res.ok).toBe(false);
    }
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("reports a folder that vanished from disk instead of opening it", async () => {
    const shell = makeShell();
    const res = await revealProjectFolder(
      { isKnownProject: known, statDir: () => false, shell },
      "/Users/foo/proj",
    );
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: "Folder no longer exists." });
  });

  it("surfaces openPath's non-empty error string", async () => {
    const shell = makeShell();
    shell.openPath = vi.fn(() => Promise.resolve("Failed to open path"));
    const res = await revealProjectFolder(
      { isKnownProject: known, statDir: isDir, shell },
      "/Users/foo/proj",
    );
    expect(res).toEqual({ ok: false, error: "Failed to open path" });
  });
});

describe("revealSessionTranscript", () => {
  const resolves = () => "/logs/s1.jsonl";

  it("selects the transcript file in the OS file manager", () => {
    const shell = makeShell();
    const res = revealSessionTranscript(
      { resolveTranscriptPath: resolves, exists: () => true, shell },
      "s1",
    );
    expect(shell.showItemInFolder).toHaveBeenCalledWith("/logs/s1.jsonl");
    expect(res).toEqual({ ok: true });
  });

  it("reports a session with no transcript file (e.g. opencode) without calling shell", () => {
    const shell = makeShell();
    const res = revealSessionTranscript(
      { resolveTranscriptPath: () => null, exists: () => true, shell },
      "s1",
    );
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: false,
      error: "No transcript file for this session.",
    });
  });

  it("reports a transcript file that no longer exists", () => {
    const shell = makeShell();
    const res = revealSessionTranscript(
      { resolveTranscriptPath: resolves, exists: () => false, shell },
      "s1",
    );
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: false,
      error: "Transcript file no longer exists.",
    });
  });

  it("refuses malformed ids from the renderer", () => {
    const shell = makeShell();
    for (const bad of ["", 7, null, undefined]) {
      expect(
        revealSessionTranscript(
          { resolveTranscriptPath: resolves, exists: () => true, shell },
          bad,
        ).ok,
      ).toBe(false);
    }
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe("isProjectWithinKnownDirs", () => {
  const known = ["/Users/foo/proj/src", "/Users/foo/other"];

  it("accepts an exact known cwd", () => {
    expect(isProjectWithinKnownDirs("/Users/foo/other", known)).toBe(true);
  });

  it("accepts a repository root that is an ancestor of a session cwd", () => {
    expect(isProjectWithinKnownDirs("/Users/foo/proj", known)).toBe(true);
  });

  it("accepts a descendant folder", () => {
    expect(isProjectWithinKnownDirs("/Users/foo/other/lib", known)).toBe(true);
  });

  it("rejects a sibling that only shares a name prefix", () => {
    expect(isProjectWithinKnownDirs("/Users/foo/proj-old", known)).toBe(false);
    expect(isProjectWithinKnownDirs("/Users/foo/oth", known)).toBe(false);
  });

  it("tolerates trailing separators on either side", () => {
    expect(isProjectWithinKnownDirs("/Users/foo/proj/", known)).toBe(true);
    expect(
      isProjectWithinKnownDirs("/Users/foo/proj", ["/Users/foo/proj/src/"]),
    ).toBe(true);
  });

  it("rejects empty and unknown paths", () => {
    expect(isProjectWithinKnownDirs("", known)).toBe(false);
    expect(isProjectWithinKnownDirs("/etc", known)).toBe(false);
    expect(isProjectWithinKnownDirs("/etc", [])).toBe(false);
  });

  it("matches Windows-style boundaries too", () => {
    expect(
      isProjectWithinKnownDirs("C:\\work\\proj", ["C:\\work\\proj\\src"]),
    ).toBe(true);
    expect(
      isProjectWithinKnownDirs("C:\\work\\proj-old", ["C:\\work\\proj\\src"]),
    ).toBe(false);
  });
});

describe("isProjectWithinKnownDirs on Windows", () => {
  const known = ["C:\\work\\Proj\\src"];

  it("matches regardless of case when the flag is on", () => {
    expect(isProjectWithinKnownDirs("c:\\WORK\\proj", known, true)).toBe(true);
  });

  it("stays case-sensitive on POSIX hosts", () => {
    expect(
      isProjectWithinKnownDirs("/work/Proj", ["/work/proj/src"], false),
    ).toBe(false);
  });

  it("still refuses a sibling prefix on Windows", () => {
    expect(isProjectWithinKnownDirs("C:\\work\\Proj-old", known, true)).toBe(
      false,
    );
  });
});
