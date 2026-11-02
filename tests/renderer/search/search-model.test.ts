import { describe, expect, it } from "vitest";
import { splitSnippet } from "../../../src/renderer/src/search/search-model";

describe("splitSnippet (SQLite snippet marks)", () => {
  it("highlights '…'-open / '»'-close spans, leaving text and '«' ellipses plain", () => {
    // sequence: ellipsis('«') + " with " + '…jump»'
    expect(splitSnippet("« with …jump»")).toEqual([
      { text: "« with ", hit: false },
      { text: "jump", hit: true },
    ]);
  });

  it("handles multiple highlighted terms", () => {
    expect(splitSnippet("…a» b …c» x")).toEqual([
      { text: "a", hit: true },
      { text: " b ", hit: false },
      { text: "c", hit: true },
      { text: " x", hit: false },
    ]);
  });

  it("returns plain text when no marks are present", () => {
    expect(splitSnippet("no marks here")).toEqual([
      { text: "no marks here", hit: false },
    ]);
    expect(splitSnippet("")).toEqual([{ text: "", hit: false }]);
  });

  it("never emits an empty leading/trailing plain span", () => {
    expect(splitSnippet("…hi»")).toEqual([{ text: "hi", hit: true }]);
  });
});
