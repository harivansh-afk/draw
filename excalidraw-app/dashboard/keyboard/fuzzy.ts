/**
 * Subsequence matching for the command palette: every query character must
 * appear in order. Consecutive hits and hits on word starts score higher, so
 * "mt" prefers "move to trash" over "import". Case- and accent-insensitive.
 */
const fold = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export const fuzzyScore = (query: string, text: string): number | null => {
  const q = fold(query).replace(/\s+/g, "");
  if (!q) {
    return 0;
  }
  const t = fold(text);
  let score = 0;
  let ti = 0;
  let previous = -2;
  for (const char of q) {
    const at = t.indexOf(char, ti);
    if (at === -1) {
      return null;
    }
    score += 1;
    if (at === previous + 1) {
      score += 2;
    }
    if (at === 0 || /[\s\-_/.(]/.test(t[at - 1])) {
      score += 3;
    }
    previous = at;
    ti = at + 1;
  }
  return score - t.length / 100;
};

export const fuzzyRank = <T>(
  items: readonly T[],
  query: string,
  haystack: (item: T) => string,
): T[] =>
  items
    .map((item, index) => ({
      item,
      index,
      score: fuzzyScore(query, haystack(item)),
    }))
    .filter(
      (entry): entry is { item: T; index: number; score: number } =>
        entry.score !== null,
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
