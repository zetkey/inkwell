import { describe, expect, it } from "vitest";
import { collabPathForShare, ownerCollabPath } from "./paths";

describe("ownerCollabPath", () => {
  it("is the session route under /api/files", () => {
    expect(ownerCollabPath("file-1")).toBe("/api/files/file-1/collab");
  });

  it("encodes the file id", () => {
    expect(ownerCollabPath("a/b c")).toBe("/api/files/a%2Fb%20c/collab");
  });
});

describe("collabPathForShare", () => {
  it("uses the file-share route", () => {
    expect(collabPathForShare({ kind: "file", token: "tok-1" })).toBe("/api/share/tok-1/collab");
  });

  it("uses the folder-share route", () => {
    expect(collabPathForShare({ kind: "folder", token: "tok-1", fileId: "file-1" })).toBe(
      "/api/share/tok-1/files/file-1/collab",
    );
  });

  it("encodes token and file id", () => {
    expect(collabPathForShare({ kind: "file", token: "a/b c" })).toBe(
      "/api/share/a%2Fb%20c/collab",
    );
    expect(collabPathForShare({ kind: "folder", token: "t?x=1", fileId: "f#2" })).toBe(
      "/api/share/t%3Fx%3D1/files/f%232/collab",
    );
  });
});
