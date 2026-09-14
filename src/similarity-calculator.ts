import { PorterStemmer } from 'natural/lib/natural/stemmers';
import { JaroWinklerDistance } from 'natural/lib/natural/distance';

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Precomputed once per unique candidate name (see CategorySuggestionOptimizer),
 * instead of re-normalizing and re-stemming inside every pairwise comparison. */
export interface NameRepresentation {
  normalized: string;
  tokens: Set<string>;
}

/**
 * The merge threshold used everywhere in this codebase two category names are
 * compared for similarity (CategorySuggestionOptimizer's clustering, and
 * CategorySuggester's match-against-existing-categories) — shorter names need a
 * higher score to merge, since a short common substring is weaker evidence of a
 * real match than the same overlap in a longer name. No env var: there's no
 * existing numeric-threshold config in this project to follow the style of, and a
 * single well-named constant is simpler than inventing one for a value nobody has
 * asked to tune.
 */
export function dynamicSimilarityThreshold(minLength: number): number {
  return 0.7 + (1 / Math.max(5, minLength)) * 0.3;
}

class SimilarityCalculator {
  public represent(name: string): NameRepresentation {
    const normalized = normalize(name);
    // tokenizeAndStem lowercases, drops English stopwords, and applies the Porter
    // stemmer so plurals ("sport"/"sports"), -ies ("category"/"categories"), and
    // -ation ("transport"/"transportation") collapse to the same stem.
    const tokens = new Set(PorterStemmer.tokenizeAndStem(normalized));
    return { normalized, tokens };
  }

  /**
   * True when `a` and `b` are guaranteed to score below any threshold this codebase
   * uses (the dynamic threshold in CategorySuggestionOptimizer never goes below
   * 0.7), so the full comparison can be skipped. Provably safe, not a heuristic: with
   * zero shared stems, wordSimilarity is 0 and the subset boost requires the smaller
   * token set to be empty (which this excludes by requiring both non-empty) — so the
   * only remaining term is `0.4 * charSimilarity`, capped at 0.4 even in the best
   * case.
   */
  public isDefinitelyDissimilar(a: NameRepresentation, b: NameRepresentation): boolean {
    if (a.tokens.size === 0 || b.tokens.size === 0) {
      return false;
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const token of a.tokens) {
      if (b.tokens.has(token)) {
        return false;
      }
    }
    return true;
  }

  public calculateSimilarity(a: NameRepresentation, b: NameRepresentation): number {
    if (a.normalized === b.normalized) return 1.0;
    if (this.isDefinitelyDissimilar(a, b)) return 0;

    const intersection = new Set([...a.tokens].filter((x) => b.tokens.has(x)));
    const union = new Set([...a.tokens, ...b.tokens]);
    const wordSimilarity = union.size === 0 ? 0 : intersection.size / union.size;

    // Subset boost: when one name's content words are fully contained in
    // the other's, the shorter name is likely a coarser version of the
    // same concept ("Travel" ⊆ "Travel & Transport"). Nudge the score so
    // these cluster together instead of bloating the category list.
    const smallerSize = Math.min(a.tokens.size, b.tokens.size);
    const isSubset = smallerSize > 0 && intersection.size === smallerSize;
    const subsetBoost = isSubset ? 0.15 : 0;

    const charSimilarity = JaroWinklerDistance(a.normalized, b.normalized);

    return Math.min(1.0, 0.6 * wordSimilarity + 0.4 * charSimilarity + subsetBoost);
  }

  /** Convenience one-shot form — computes both representations then compares. Used
   * by callers with only a handful of one-off comparisons (e.g. matching a single
   * suggestion against existing categories); the optimizer's O(K²) loop uses
   * represent()/calculateSimilarity() directly so it only pays the represent() cost
   * once per candidate, not once per pair. */
  public calculateNameSimilarity(name1: string, name2: string): number {
    return this.calculateSimilarity(this.represent(name1), this.represent(name2));
  }
}

export default SimilarityCalculator;
