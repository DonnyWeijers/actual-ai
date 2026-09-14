import {
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/src/types/models';
import { APIPayeeEntity } from '@actual-app/core/src/server/api-models';
import {
  ActualApiServiceI, APICategoryEntity, APICategoryGroupEntity,
  LlmServiceI, ProcessingStrategyI,
  PromptGeneratorI,
} from '../types';
import TagService from './tag-service';
import PayeeCategoryCache from './payee-category-cache';

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

  public async process(
    transaction: TransactionEntity,
    categoryGroups: APICategoryGroupEntity[],
    payees: APIPayeeEntity[],
    rules: RuleEntity[],
    categories: (APICategoryEntity | APICategoryGroupEntity)[],
    suggestedCategories: Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>,
  ): Promise<void> {
    try {
      const cachedResponse = this.payeeCategoryCache.get(transaction.payee);
      const response = cachedResponse ?? await (async () => {
        const prompt = this.promptGenerator.generate(
          categoryGroups,
          transaction,
          payees,
          rules,
        );
        const fresh = await this.llmService.ask(prompt);
        this.payeeCategoryCache.set(transaction.payee, fresh);
        return fresh;
      })();

      if (cachedResponse) {
        console.log(`Using cached categorization for payee ${transaction.payee}`);
      }

      const strategy = this.processingStrategies.find((s) => s.isSatisfiedBy(response));
      if (strategy) {
        await strategy.process(transaction, response, categories, suggestedCategories);
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
