import type { LoopPosition } from "./execution.js";

/**
 * The words a review's `detail` and choice descriptions may ask for, filled
 * from the loops around the review: the innermost Map gives the item, the
 * innermost Repeat the try. Each counts from 1, as a person does.
 */
export const reviewTextPlaceholders = [
  "item",
  "items",
  "try",
  "tries",
] as const;
type Placeholder = (typeof reviewTextPlaceholders)[number];

const placeholder = /\{([A-Za-z]+)\}/g;
const known = (name: string): name is Placeholder =>
  reviewTextPlaceholders.some((candidate) => candidate === name);

/** Placeholder names in `text` that no review can fill. */
export function unknownReviewPlaceholders(text: string): string[] {
  return [...text.matchAll(placeholder)].flatMap(([, name = ""]) =>
    known(name) ? [] : [name],
  );
}

/**
 * Fill a review's text from where it runs. Text whose placeholders the
 * position cannot fill (a `{try}` outside any Repeat) is not shown at all,
 * rather than shown with a hole or a guess.
 */
export function fillReviewText(
  text: string,
  position: LoopPosition = [],
): string | undefined {
  const map = position.findLast((place) => place.loop === "map");
  const repeat = position.findLast((place) => place.loop === "repeat");
  const values = {
    item: map === undefined ? undefined : map.index + 1,
    items: map?.count,
    try: repeat === undefined ? undefined : repeat.index + 1,
    tries: repeat?.count,
  } satisfies Record<Placeholder, number | undefined>;
  const valueOf = (name: string) => (known(name) ? values[name] : undefined);
  const names = [...text.matchAll(placeholder)].map(([, name = ""]) => name);
  if (names.some((name) => valueOf(name) === undefined)) return undefined;
  return text.replace(placeholder, (whole, name: string) => {
    const value = valueOf(name);
    return value === undefined ? whole : String(value);
  });
}
