/** How long a pressed `g` stays armed as a navigation prefix. */
export const GO_CHORD_MS = 800;

/**
 * Shared "a `g` prefix is armed" timestamp. Chord suffixes and single-key
 * list verbs (`o` open, `w`, …) ride the same keydown on two window
 * listeners, and listener order flips with mount order — so the list-verb
 * side (`useListKeys`) stands down for the whole chord window instead of
 * trying to race. Time-based only: never cleared synchronously, or the
 * later-registered listener would see it already unset.
 */
export const goPrefix = { armedAt: 0 };

export function goPrefixActive(now: number = Date.now()): boolean {
  return goPrefix.armedAt > 0 && now - goPrefix.armedAt < GO_CHORD_MS;
}

/**
 * The `g`-prefix chord state machine (spec §5): `g g`, `g o`, `g e`, `g p`,
 * `g r`, `g t`, `g w`. Kept free of React and the DOM so it is testable —
 * `useGoSequences` owns the listener, the key guard and `preventDefault`.
 *
 * Returns a stepper: feed it key names, and it answers whether this key
 * completed a chord. `g` is both the prefix and the Graph suffix, so a key
 * is matched against the map *before* it is considered as a new prefix.
 */
export function goSequence(
  hasTarget: (key: string) => boolean,
  now: () => number = Date.now,
) {
  let pendingG = 0;
  return function press(key: string): boolean {
    if (pendingG && now() - pendingG < GO_CHORD_MS && hasTarget(key)) {
      pendingG = 0;
      return true;
    }
    pendingG = key === "g" ? now() : 0;
    return false;
  };
}
