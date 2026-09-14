import type {
  TransactionEntity,
} from '@actual-app/core/src/types/models';
import SimilarityCalculator, { NameRepresentation, dynamicSimilarityThreshold } from './similarity-calculator';
import metrics from './utils/metrics';
import UnionFind from './utils/union-find';

interface Suggestion {
  name: string;
  groupName: string;
  groupIsNew: boolean;
  groupId?: string;
  transactions: TransactionEntity[];
}

class CategorySuggestionOptimizer {
  private readonly similarityCalculator: SimilarityCalculator;

  constructor(
    similarityCalculator: SimilarityCalculator,
  ) {
    this.similarityCalculator = similarityCalculator;
  }

  public optimizeCategorySuggestions(
    suggestedCategories: Map<string, Suggestion>,
  ): Map<string, Suggestion> {
    console.log('Optimizing category suggestions...');

    const suggestions = Array.from(suggestedCategories.values());

    // Precompute once per unique candidate (2.3) instead of re-normalizing/
    // re-stemming inside every one of the O(K²) pairwise comparisons below.
    const representations: NameRepresentation[] = suggestions.map(
      (s) => this.similarityCalculator.represent(s.name),
    );

    const unionFind = new UnionFind(suggestions.length);
    for (let i = 0; i < suggestions.length; i += 1) {
      for (let j = i + 1; j < suggestions.length; j += 1) {
        // Cheap, provably-safe skip (see SimilarityCalculator.isDefinitelyDissimilar)
        // before paying for the full comparison.
        const repI = representations[i];
        const repJ = representations[j];
        if (this.similarityCalculator.isDefinitelyDissimilar(repI, repJ)) {
          continue;
        }
        const minLength = Math.min(suggestions[i].name.length, suggestions[j].name.length);
        const dynamicThreshold = dynamicSimilarityThreshold(minLength);
        const sim = this.similarityCalculator.calculateSimilarity(repI, repJ);
        if (sim >= dynamicThreshold) {
          unionFind.union(i, j);
        }
      }
    }

    // Group indices by root — order-independent by construction (2.4): the same set
    // of above-threshold pairs always produces the same partition, regardless of
    // which order they were discovered/unioned in.
    const clustersByRoot = new Map<number, number[]>();
    for (let i = 0; i < suggestions.length; i += 1) {
      const root = unionFind.find(i);
      const members = clustersByRoot.get(root) ?? [];
      members.push(i);
      clustersByRoot.set(root, members);
    }

    const optimizedCategories = new Map<string, Suggestion & { originalNames: string[] }>();
    clustersByRoot.forEach((memberIndices) => {
      const cluster = memberIndices.map((i) => suggestions[i]);
      const mergedTransactions = cluster.flatMap((s) => s.transactions);
      const originalNames = cluster.map((s) => s.name);
      const bestName = this.chooseBestCategoryName(originalNames);

      const groupCount = new Map<string, number>();
      cluster.forEach((s) => {
        groupCount.set(s.groupName, (groupCount.get(s.groupName) ?? 0) + 1);
      });
      let repGroup = cluster[0].groupName;
      let maxCount = 0;
      // Sorted so a tie between equally-frequent group names resolves the same way
      // regardless of Map iteration/insertion order.
      const sortedGroupCounts = Array.from(groupCount.entries())
        .sort(([a], [b]) => a.localeCompare(b));
      sortedGroupCounts.forEach(([grp, cnt]) => {
        if (cnt > maxCount) {
          maxCount = cnt;
          repGroup = grp;
        }
      });

      const groupIsNew = cluster.some((s) => s.groupIsNew);
      optimizedCategories.set(`${repGroup}:${bestName}`, {
        name: bestName,
        groupName: repGroup,
        groupIsNew,
        groupId: undefined,
        transactions: mergedTransactions,
        originalNames,
      });
    });

    metrics.incr('category_suggestions_merged', optimizedCategories.size);
    console.log(`Optimized from ${suggestions.length} to ${optimizedCategories.size} categories`);
    optimizedCategories.forEach((category) => {
      if (category.originalNames.length > 1) {
        console.log(`Merged categories ${category.originalNames.join(', ')} into "${category.name}"`);
      }
    });

    return new Map(
      Array.from(optimizedCategories.entries()).map(([key, value]) => [
        key,
        {
          name: value.name,
          groupName: value.groupName,
          groupIsNew: value.groupIsNew,
          groupId: value.groupId,
          transactions: value.transactions,
        },
      ]),
    );
  }

  private chooseBestCategoryName(names: string[]): string {
    if (names.length === 1) return names[0];

    // Count frequency of words across all names
    const wordFrequency = new Map<string, number>();
    const nameWords = names.map((name) => {
      const words = name.toLowerCase().split(/\s+/);
      words.forEach((word) => {
        wordFrequency.set(word, (wordFrequency.get(word) ?? 0) + 1);
      });
      return words;
    });

    // Score each name based on word frequency (more common words are better)
    const scores = names.map((name, i) => {
      const words = nameWords[i];
      const freqScore = words.reduce(
        (sum, word) => sum + wordFrequency.get(word)!,
        0,
      ) / words.length;

      // Prefer names that are in the sweet spot length (not too short, not too long)
      const lengthScore = 1 / (1 + Math.abs(words.length - 2));

      return { name, score: freqScore * 0.7 + lengthScore * 0.3 };
    });

    // Sort by score (descending); ties break alphabetically so the result doesn't
    // depend on the names' original order (2.4 determinism).
    scores.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scores[0].name;
  }
}

export default CategorySuggestionOptimizer;
