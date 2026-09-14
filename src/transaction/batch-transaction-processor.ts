import {
  RuleEntity,
  TransactionEntity,
} from '@actual-app/core/src/types/models';
import { APIPayeeEntity } from '@actual-app/core/src/server/api-models';
import {
  APICategoryEntity, APICategoryGroupEntity,
} from '../types';
import TransactionProcessor from './transaction-processor';
import PayeeCategoryCache from './payee-category-cache';

class BatchTransactionProcessor {
  private readonly transactionProcessor: TransactionProcessor;

  private readonly batchSize: number;

  private readonly payeeCategoryCache: PayeeCategoryCache;

  constructor(
    transactionProcessor: TransactionProcessor,
    batchSize: number,
    payeeCategoryCache: PayeeCategoryCache,
  ) {
    this.transactionProcessor = transactionProcessor;
    this.batchSize = batchSize;
    this.payeeCategoryCache = payeeCategoryCache;
  }

  public async process(
    uncategorizedTransactions: TransactionEntity[],
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
    // Built once for the whole run, not once per transaction: compiling the template
    // and rebuilding groupsWithCategories/rulesDescription/the payee index is the
    // same work every time since categoryGroups/payees/rules don't change mid-run
    // (see PromptGenerator.createRunContext's docstring for why that's safe).
    const promptContext = this.transactionProcessor.createPromptContext(categoryGroups, payees, rules);
    // Same reasoning: ExistingCategoryStrategy looks up a category by id on every
    // transaction with an "existing" response — index once instead of a linear
    // .find() over `categories` per transaction.
    const categoryById = new Map(categories.map((category) => [category.id, category]));

    for (
      let batchStart = 0;
      batchStart < uncategorizedTransactions.length;
      batchStart += this.batchSize
    ) {
      const batchEnd = Math.min(batchStart + this.batchSize, uncategorizedTransactions.length);
      console.log(`Processing batch ${batchStart / this.batchSize + 1} (transactions ${batchStart + 1}-${batchEnd})`);

      const batch = uncategorizedTransactions.slice(batchStart, batchEnd);

      await batch.reduce(async (previousPromise, transaction, batchIndex) => {
        await previousPromise;
        const globalIndex = batchStart + batchIndex;
        console.log(
          `${globalIndex + 1}/${uncategorizedTransactions.length} Processing transaction '${transaction.imported_payee}'`,
        );

        await this.transactionProcessor.process(
          transaction,
          promptContext,
          categoryById,
          suggestedCategories,
        );
      }, Promise.resolve());

      // Add a small delay between batches to avoid overwhelming the API
      if (batchEnd < uncategorizedTransactions.length) {
        console.log('Pausing for 2 seconds before next batch...');
        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });
      }
    }

    this.payeeCategoryCache.logSummary();
  }
}

export default BatchTransactionProcessor;
