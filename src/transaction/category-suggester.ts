import type { TransactionEntity } from '@actual-app/core/src/types/models';
import type { ActualApiServiceI } from '../types';
import { APICategoryEntity, APICategoryGroupEntity } from '../types';
import CategorySuggestionOptimizer from '../category-suggestion-optimizer';
import SimilarityCalculator, { NameRepresentation, dynamicSimilarityThreshold } from '../similarity-calculator';
import TagService from './tag-service';
import metrics from '../utils/metrics';
import mapWithConcurrency from '../utils/concurrency';

// Bounds how many category-creation / transaction-update writes to Actual run at
// once (R8: this used to be a fully unbounded Promise.all over every category and,
// nested inside that, every one of its transactions). Not user-configurable: unlike
// LLM_CONCURRENCY, there's no real per-provider tradeoff here to expose, just a cap
// against hammering Actual's API.
const WRITE_CONCURRENCY = 5;

interface ExistingCategoryWithRep {
  id: string;
  groupId: string;
  name: string;
  rep: NameRepresentation;
}

class CategorySuggester {
  private readonly actualApiService: ActualApiServiceI;

  private readonly categorySuggestionOptimizer: CategorySuggestionOptimizer;

  private readonly similarityCalculator: SimilarityCalculator;

  private readonly tagService: TagService;

  // Memoized per `suggest()` call (see findCategoryId): a hidden-category collision
  // refetches the full category list once, and every later collision in the same run
  // reuses that same result instead of each triggering its own full refetch. Reset at
  // the top of suggest() so results don't leak between runs.
  private categoriesPromise: Promise<(APICategoryEntity | APICategoryGroupEntity)[]> | undefined;

  constructor(
    actualApiService: ActualApiServiceI,
    categorySuggestionOptimizer: CategorySuggestionOptimizer,
    tagService: TagService,
    similarityCalculator: SimilarityCalculator = new SimilarityCalculator(),
  ) {
    this.actualApiService = actualApiService;
    this.categorySuggestionOptimizer = categorySuggestionOptimizer;
    this.tagService = tagService;
    this.similarityCalculator = similarityCalculator;
  }

  public async suggest(
    suggestedCategories: Map<string, {
            name: string;
            groupName: string;
            groupIsNew: boolean;
            groupId?: string;
            transactions: TransactionEntity[];
        }>,
    uncategorizedTransactions: TransactionEntity[],
    categoryGroups: APICategoryGroupEntity[],
  ): Promise<void> {
    this.categoriesPromise = undefined;

    metrics.incr(
      'existing_category_count',
      categoryGroups.reduce((sum, group) => sum + (group.categories?.length ?? 0), 0),
    );

    // Optimize categories before applying/reporting
    const optimizedCategories = this.categorySuggestionOptimizer
      .optimizeCategorySuggestions(suggestedCategories);

    console.log(`Creating ${optimizedCategories.size} optimized categories`);

    // Resolve unique group names to IDs sequentially before the parallel
    // category creation. The LLM-supplied `groupIsNew` flag cannot be
    // trusted (it sometimes claims existing groups are new), and creating
    // groups in parallel races on the Actual Budget API which throws
    // "category group already exists" when two creations collide.
    const uniqueGroupNames = Array.from(new Set(
      Array.from(optimizedCategories.values()).map((s) => s.groupName),
    ));
    const categoryGroupByNormalizedName = new Map(
      categoryGroups.map((group) => [group.name.toLowerCase(), group]),
    );
    const groupIdByName = new Map<string, string>();
    // eslint-disable-next-line no-restricted-syntax
    for (const groupName of uniqueGroupNames) {
      const existing = categoryGroupByNormalizedName.get(groupName.toLowerCase());
      if (existing) {
        metrics.incr('existing_group_count');
        groupIdByName.set(groupName, existing.id);
      } else {
        try {
          const newId = await this.actualApiService.createCategoryGroup(groupName);
          groupIdByName.set(groupName, newId);
          console.log(`Created new category group "${groupName}" with ID ${newId}`);
        } catch (error) {
          console.error(`Error creating category group ${groupName}:`, error);
        }
      }
    }

    // The LLM regularly suggests categories that already exist, and Actual Budget throws
    // "category already exists in group" for those. Index what is already there so those
    // suggestions reuse the existing category instead of failing.
    const existingCategoryIds = new Map<string, string>();
    categoryGroups.forEach((group) => {
      (group.categories ?? []).forEach((category) => {
        existingCategoryIds.set(CategorySuggester.categoryKey(group.id, category.name), category.id);
      });
    });

    // R5: an exact-name match (above) only catches "Groceries" vs "groceries" —
    // "Grocery Shopping" next to an existing "Groceries" still slipped through as a
    // near-duplicate. Precomputed once per existing category (2.3's spirit), reused
    // for every suggestion's fuzzy lookup below instead of re-stemming per pair.
    const existingCategoriesWithReps = categoryGroups.flatMap(
      (group) => (group.categories ?? []).map((category) => ({
        id: category.id,
        groupId: group.id,
        name: category.name,
        rep: this.similarityCalculator.represent(category.name),
      })),
    );

    // Two suggestions can optimize down to the same category; share one creation between them
    // so the parallel loop below cannot race the API into the same duplicate error.
    const pendingCategoryIds = new Map<string, Promise<string>>();
    const resolveCategoryId = async (groupId: string, name: string): Promise<string> => {
      const key = CategorySuggester.categoryKey(groupId, name);
      const existingId = existingCategoryIds.get(key);
      if (existingId) {
        metrics.incr('categories_reused');
        console.log(`Reusing existing category "${name}" with ID ${existingId}`);
        return existingId;
      }

      const fuzzyMatch = this
        .findSimilarExistingCategory(name, groupId, existingCategoriesWithReps);
      if (fuzzyMatch) {
        metrics.incr('categories_reused');
        console.log(
          `Reusing existing category "${fuzzyMatch.name}" (similar to suggested "${name}") with ID ${fuzzyMatch.id}`,
        );
        return fuzzyMatch.id;
      }

      let pending = pendingCategoryIds.get(key);
      if (!pending) {
        pending = this.createCategory(name, groupId);
        pendingCategoryIds.set(key, pending);
      }
      return pending;
    };

    // Bounded, not unbounded (R8). Group resolution above stays sequential — that's
    // the race fix and does not change — but categories within already-resolved
    // groups are independent of each other, so creating/resolving them up to
    // WRITE_CONCURRENCY at a time is safe. A category's own transaction updates
    // depend on that category's id existing first, so they're bounded separately,
    // nested inside its own creation.
    await mapWithConcurrency(
      Array.from(optimizedCategories.values()),
      WRITE_CONCURRENCY,
      async (suggestion) => {
        try {
          const groupId = groupIdByName.get(suggestion.groupName);
          if (!groupId) {
            throw new Error(`Missing groupId for category ${suggestion.name}`);
          }

          const categoryId = await resolveCategoryId(groupId, suggestion.name);

          await mapWithConcurrency(
            suggestion.transactions,
            WRITE_CONCURRENCY,
            async (transaction) => {
              await this.actualApiService.updateTransactionNotesAndCategory(
                transaction.id,
                this.tagService.addGuessedTag(transaction.notes ?? ''),
                categoryId,
              );
              console.log(`Assigned transaction ${transaction.id} to category ${suggestion.name}`);
            },
          );
        } catch (error) {
          console.error(`Error assigning category ${suggestion.name}:`, error);
        }
      },
    );
  }

  /**
   * Fuzzy match against existing categories (2.2), tried within the target group
   * first (a match there is unambiguous — same group the LLM was already
   * suggesting), then globally across every group if nothing in-group qualifies.
   * A global match wins over creating a near-duplicate even though it means the
   * transaction lands in a different group than suggested — the whole point is
   * avoiding a second "Groceries"-shaped category, not honoring the LLM's group
   * guess over reality.
   */
  private findSimilarExistingCategory(
    name: string,
    groupId: string,
    existingCategoriesWithReps: ExistingCategoryWithRep[],
  ): { id: string; name: string } | undefined {
    const rep = this.similarityCalculator.represent(name);
    const inGroup = existingCategoriesWithReps.filter((c) => c.groupId === groupId);
    return this.findBestMatch(rep, inGroup) ?? this.findBestMatch(rep, existingCategoriesWithReps);
  }

  private findBestMatch(
    rep: NameRepresentation,
    candidates: ExistingCategoryWithRep[],
  ): { id: string; name: string } | undefined {
    let best: { id: string; name: string; score: number } | undefined;
    candidates.forEach((candidate) => {
      if (this.similarityCalculator.isDefinitelyDissimilar(rep, candidate.rep)) {
        return;
      }
      const minLength = Math.min(rep.normalized.length, candidate.rep.normalized.length);
      const threshold = dynamicSimilarityThreshold(minLength);
      const score = this.similarityCalculator.calculateSimilarity(rep, candidate.rep);
      if (score >= threshold && (!best || score > best.score)) {
        best = { id: candidate.id, name: candidate.name, score };
      }
    });
    return best;
  }

  private async createCategory(name: string, groupId: string): Promise<string> {
    try {
      const newCategoryId = await this.actualApiService.createCategory(name, groupId);
      console.log(`Created new category "${name}" with ID ${newCategoryId}`);
      return newCategoryId;
    } catch (error) {
      // Hidden categories are missing from the group listing, so a name can still collide here.
      const existingId = await this.findCategoryId(name, groupId);
      if (existingId === undefined) {
        throw error;
      }
      metrics.incr('categories_reused');
      console.log(`Category "${name}" already exists, reusing ID ${existingId}`);
      return existingId;
    }
  }

  private async findCategoryId(name: string, groupId: string): Promise<string | undefined> {
    this.categoriesPromise ??= this.actualApiService.getCategories();
    const categories = await this.categoriesPromise;
    const match = categories.find((category) => {
      const { group_id: categoryGroupId } = category as APICategoryEntity & { group_id?: string };
      return categoryGroupId === groupId
        && category.name.toLowerCase() === name.toLowerCase();
    });
    return match?.id;
  }

  private static categoryKey(groupId: string, name: string): string {
    return `${groupId}::${name.toLowerCase()}`;
  }
}

export default CategorySuggester;
