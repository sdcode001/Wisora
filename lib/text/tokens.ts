const STOPWORDS = new Set([
  "for", "and", "the", "with", "under", "from", "that", "this", "your",
  "you", "are", "without", "compare", "find", "suggest", "best", "good",
  "great", "excellent", "suitable", "simple", "daily", "routine",
  "comfortable", "products", "product", "options", "option", "around",
  "about", "budget", "between",
]);

export function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}
