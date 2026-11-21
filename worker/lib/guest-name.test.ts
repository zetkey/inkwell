import { describe, expect, it } from "vitest";
import {
  GUEST_EN_ANIMALS,
  GUEST_EN_TRAITS,
  GUEST_ID_ANIMALS,
  GUEST_ID_TRAITS,
  guestNameFromPicks,
  randomGuestName,
} from "./guest-name";

const NAME = /^[a-z]+(_[a-z]+)+$/;
const samples = Array.from({ length: 200 }, () => randomGuestName());

describe("guestNameFromPicks", () => {
  it("puts the trait first in English and the animal first in Indonesian", () => {
    expect(guestNameFromPicks("en", "smiling", "Fish")).toBe("smiling_fish");
    expect(guestNameFromPicks("id", "Terjatuh", "Kuda")).toBe("kuda_terjatuh");
  });
});

describe("randomGuestName", () => {
  it("produces ascii lowercase underscore names within 40 chars", () => {
    for (const name of samples) {
      expect(name).toMatch(NAME);
      expect(name.length).toBeLessThanOrEqual(40);
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("is mostly unique over 200 samples", () => {
    expect(new Set(samples).size).toBeGreaterThanOrEqual(180);
  });

  it("draws from both language pools without mixing them", () => {
    const english = samples.filter(
      (n) =>
        GUEST_EN_TRAITS.some((t) => n.startsWith(`${t}_`)) &&
        GUEST_EN_ANIMALS.some((a) => n.endsWith(`_${a}`)),
    );
    const indonesian = samples.filter(
      (n) =>
        GUEST_ID_ANIMALS.some((a) => n.startsWith(`${a}_`)) &&
        GUEST_ID_TRAITS.some((t) => n.endsWith(`_${t}`)),
    );
    expect(english.length).toBeGreaterThan(0);
    expect(indonesian.length).toBeGreaterThan(0);
    expect(english.length + indonesian.length).toBe(samples.length);
  });
});
