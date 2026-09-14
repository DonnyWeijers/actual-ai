import {
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/src/types/models';
import { APIPayeeEntity } from '@actual-app/core/src/server/api-models';
import {
  ActualApiServiceI, APICategoryEntity, APICategoryGroupEntity,
  LlmServiceI, ProcessingStrategyI,
  PromptGeneratorI, PromptRunContext,
} from '../types';
import TagService from './tag-service';
import PayeeCategoryCache from './payee-category-cache';
import { deriveFallbackDedupKey } from './dedup-key';
import { isFeatureEnabled } from '../config';
import metrics from '../utils/metrics';

class TransactionProcessor {
  private readonly actualApiService: ActualApiServiceI;

  private readonly llmService: LlmServiceI;

  private readonly promptGenerator: PromptGeneratorI;

  private readonly tagService: TagService;

  private readonly processingStrategies: ProcessingStrategyI[];

  private readonly payeeCategoryCache: PayeeCategoryCache;

  constructor(
    actualApiClient: ActualApiServiceI,
    llmService: LlmServiceI,
    promptGenerator: PromptGeneratorI,
    tagService: TagService,
    processingStrategies: ProcessingStrategyI[],
    payeeCategoryCache: PayeeCategoryCache,
  ) {
    this.actualApiService = actualApiClient;
    this.llmService = llmService;
    this.promptGenerator = promptGenerator;
    this.tagService = tagService;
    this.processingStrategies = processingStrategies;
    this.payeeCategoryCache = payeeCategoryCache;
  }

  /** Builds the run-invariant prompt context once; see PromptGenerator.createRunContext. */
  public createPromptContext(
    categoryGroups: APICategoryGroupEntity[],
    payees: APIPayeeEntity[],
    rules: RuleEntity[],
  ): PromptRunContext {
    return this.promptGenerator.createRunContext(categoryGroups, payees, rules);
  }

  public async process(
    transaction: TransactionEntity,
    promptContext: PromptRunContext,
    categoryById: Map<string, APICategoryEntity | APICategoryGroupEntity>,
    suggestedCategories: Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>,
  ): Promise<void> {
    try {
      metrics.incr('transactions_processed');

      // Actual's own resolved payee id is always the preferred cache key — stable
      // and accurate. Only when that's absent, and only if the caller opted in
      // (dedupeUnresolvedPayees), fall back to a normalized-text key derived from
      // the same fields the prompt varies on (see dedup-key.ts for why this is
      // off by default: the normalization is heuristic).
      const cacheKey = transaction.payee
        ?? (isFeatureEnabled('dedupeUnresolvedPayees') ? deriveFallbackDedupKey(transaction) : undefined);

      const { response, fromCache } = await this.payeeCategoryCache.getOrCreate(
        cacheKey,
        async () => {
          const prompt = this.promptGenerator.generateFromContext(promptContext, transaction);
          return this.llmService.ask(prompt);
        },
      );

      if (fromCache) {
        metrics.incr('llm_cache_hits');
        console.log(`Using cached categorization for key ${cacheKey}`);
      }

      const strategy = this.processingStrategies.find((s) => s.isSatisfiedBy(response));
      if (strategy) {
        await strategy.process(transaction, response, categoryById, suggestedCategories);
        return;
      }

      console.warn(`Unexpected response format: ${JSON.stringify(response)}`);
      await this.actualApiService.updateTransactionNotes(
        transaction.id,
        this.tagService.addNotGuessedTag(transaction.notes ?? ''),
      );
    } catch (error) {
      console.error(`Error processing transaction ${transaction.id}:`, error);
      await this.actualApiService.updateTransactionNotes(
        transaction.id,
        this.tagService.addNotGuessedTag(transaction.notes ?? ''),
      );
    }
  }
}

export default TransactionProcessor;
