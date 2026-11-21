// Guest display names for collab rooms.
//
// A guest is `<trait>_<animal>` in English (smiling_fish) or
// `<animal>_<trait>` in Indonesian (kuda_terjatuh). Pools are kept
// separate per language so a name never mixes them, and picking uses
// crypto (not Math.random) so the choice is uniform.

export const GUEST_EN_TRAITS = [
  "smiling",
  "dancing",
  "sleepy",
  "sneaky",
  "grumpy",
  "bouncy",
  "salty",
  "awkward",
  "cheerful",
  "soggy",
  "ferocious",
  "polite",
  "dizzy",
  "clumsy",
  "fancy",
  "fluffy",
  "giggly",
  "gloomy",
  "hungry",
  "itchy",
  "jolly",
  "jumpy",
  "lazy",
  "lucky",
  "moody",
  "noisy",
  "peppy",
  "proud",
  "quiet",
  "shiny",
  "silly",
  "sneezy",
  "sparkly",
  "speedy",
  "spooky",
  "sunny",
  "thirsty",
  "tiny",
  "wobbly",
  "zany",
] as const;

export const GUEST_EN_ANIMALS = [
  "fish",
  "cat",
  "otter",
  "capybara",
  "pangolin",
  "axolotl",
  "gecko",
  "hamster",
  "walrus",
  "flamingo",
  "koala",
  "puffin",
  "squid",
  "raccoon",
  "moose",
  "llama",
  "badger",
  "beaver",
  "bison",
  "cobra",
  "crab",
  "crow",
  "dolphin",
  "donkey",
  "eagle",
  "ferret",
  "frog",
  "hedgehog",
  "iguana",
  "jackal",
  "lemur",
  "lobster",
  "narwhal",
  "newt",
  "ocelot",
  "ostrich",
  "owl",
  "parrot",
  "penguin",
  "platypus",
  "porcupine",
  "quokka",
  "rabbit",
  "raven",
] as const;

export const GUEST_ID_TRAITS = [
  "terjatuh",
  "ngantuk",
  "kesiangan",
  "menari",
  "mabuk",
  "romantis",
  "santai",
  "sombong",
  "sopan",
  "berpuisi",
  "kabur",
  "tersesat",
  "kepanasan",
  "baper",
  "ceria",
  "gugup",
  "lapar",
  "haus",
  "malas",
  "nakal",
  "pintar",
  "rajin",
  "sedih",
  "senang",
  "takut",
  "tertawa",
  "melompat",
  "berlari",
  "berenang",
  "menyanyi",
  "bermain",
  "tidur",
  "bangun",
  "kedinginan",
  "kebanjiran",
  "kehujanan",
  "kelaparan",
  "kemalaman",
  "bengong",
  "bergaya",
] as const;

export const GUEST_ID_ANIMALS = [
  "kuda",
  "kucing",
  "bebek",
  "sapi",
  "ayam",
  "tikus",
  "katak",
  "kerbau",
  "kambing",
  "monyet",
  "cicak",
  "ubur_ubur",
  "kancil",
  "buaya",
  "panda",
  "gajah",
  "harimau",
  "singa",
  "jerapah",
  "zebra",
  "badak",
  "komodo",
  "kadal",
  "ular",
  "ikan",
  "udang",
  "kepiting",
  "cumi_cumi",
  "gurita",
  "semut",
  "lebah",
  "kupu_kupu",
  "capung",
  "tupai",
  "landak",
  "trenggiling",
  "kukang",
  "lumba_lumba",
  "penyu",
  "merpati",
] as const;

export type GuestLanguage = "en" | "id";

// English reads trait-first, Indonesian reads animal-first.
export function guestNameFromPicks(lang: GuestLanguage, trait: string, animal: string): string {
  const parts = lang === "en" ? [trait, animal] : [animal, trait];
  return parts.join("_").toLowerCase();
}

// Uniform integer in [0, max) via rejection sampling (no modulo bias).
function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

export function randomGuestName(): string {
  // 50/50 language pick.
  if (randomInt(2) === 0) {
    return guestNameFromPicks(
      "en",
      GUEST_EN_TRAITS[randomInt(GUEST_EN_TRAITS.length)],
      GUEST_EN_ANIMALS[randomInt(GUEST_EN_ANIMALS.length)],
    );
  }
  return guestNameFromPicks(
    "id",
    GUEST_ID_TRAITS[randomInt(GUEST_ID_TRAITS.length)],
    GUEST_ID_ANIMALS[randomInt(GUEST_ID_ANIMALS.length)],
  );
}
