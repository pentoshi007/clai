const buildFallbackTable = (pattern: string): Uint32Array => {
  const fallback = new Uint32Array(pattern.length);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) {
      matched = fallback[matched - 1]!;
    }
    if (pattern[index] === pattern[matched]) matched += 1;
    fallback[index] = matched;
  }
  return fallback;
};

export const trimExactContinuationOverlap = (
  previous: string,
  current: string,
  minLength = 32,
): string => {
  if (previous.length > 0 && current.startsWith(previous)) {
    return current.slice(previous.length);
  }
  const maxLength = Math.min(previous.length, current.length);
  if (maxLength < minLength) return current;
  const pattern = current.slice(0, maxLength);
  const fallback = buildFallbackTable(pattern);
  let matched = 0;
  for (
    let index = previous.length - maxLength;
    index < previous.length;
    index += 1
  ) {
    while (matched > 0 && previous[index] !== pattern[matched]) {
      matched = fallback[matched - 1]!;
    }
    if (previous[index] === pattern[matched]) matched += 1;
    if (matched === maxLength && index < previous.length - 1) {
      matched = fallback[matched - 1]!;
    }
  }
  return matched >= minLength ? current.slice(matched) : current;
};
