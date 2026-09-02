
export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly active?: boolean | undefined;
}

export interface PickerFilterOptions {
  readonly searchDescription?: boolean | undefined;
}

function subsequenceSpan(needle: string, text: string): number | null {
  let j = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < text.length && j < needle.length; i += 1) {
    if (text[i] === needle[j]) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
      j += 1;
    }
  }
  return j === needle.length ? lastIdx - firstIdx : null;
}

function bestFieldScore(
  option: PickerOption,
  needle: string,
  searchDescription: boolean,
): number | undefined {
  const fields = [option.label, option.value];
  if (searchDescription && option.description) fields.push(option.description);

  let best: number | undefined;
  const seen = new Set<string>();
  for (let rank = 0; rank < fields.length; rank += 1) {
    const field = fields[rank]!.toLowerCase();
    if (seen.has(field)) continue;
    seen.add(field);
    const span = subsequenceSpan(needle, field);
    if (span === null) continue;
    let score = span + rank * 10_000;
    if (field.startsWith(needle)) score -= 1_000_000;
    else if (field.includes(needle)) score -= 500_000;
    if (best === undefined || score < best) best = score;
  }
  return best;
}

export function filterPickerOptions(
  options: readonly PickerOption[],
  query: string,
  filterOptions: PickerFilterOptions = {},
): PickerOption[] {
  const needle = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!needle) return [...options];

  const searchDescription = filterOptions.searchDescription ?? true;
  const scored: Array<{ option: PickerOption; score: number }> = [];
  for (const option of options) {
    const score = bestFieldScore(option, needle, searchDescription);
    if (score !== undefined) scored.push({ option, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((entry) => entry.option);
}

export function activeIndex(options: readonly PickerOption[]): number {
  const index = options.findIndex((option) => option.active);
  return Math.max(0, index);
}
