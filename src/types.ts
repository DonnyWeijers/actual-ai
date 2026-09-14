import { LanguageModel, Tool } from 'ai';
import {
  APIAccountEntity,
  APICategoryEntity as ImportedAPICategoryEntity,
  APICategoryGroupEntity as ImportedAPICategoryGroupEntity,
  APIPayeeEntity,
} from '@actual-app/core/src/server/api-models';
import {
  TransactionEntity, RuleEntity, CategoryEntity, CategoryGroupEntity,
} from '@actual-app/core/src/types/models';

export type APICategoryEntity = ImportedAPICategoryEntity | CategoryEntity;
export type APICategoryGroupEntity = ImportedAPICategoryGroupEntity | CategoryGroupEntity;

export interface LlmModelI {
  ask(prompt: string, possibleAnswers: string[]): Promise<string>;
}

export interface LlmModelFactoryI {
  create(): LanguageModel;
  getProvider(): string;
  getModelProvider(): string;
}

export interface ActualApiServiceI {
  initializeApi(): Promise<void>;

  shutdownApi(): Promise<void>;

  getCategoryGroups(): Promise<APICategoryGroupEntity[]>

  getCategories(): Promise<(APICategoryEntity | APICategoryGroupEntity)[]>

  getAccounts(): Promise<APIAccountEntity[]>

  getPayees(): Promise<APIPayeeEntity[]>

  getTransactions(): Promise<TransactionEntity[]>

  getRules(): Promise<RuleEntity[]>

  getPayeeRules(payeeId: string): Promise<RuleEntity[]>

  updateTransactionNotes(id: string, notes: string): Promise<void>

  updateTransactionNotesAndCategory(
    id: string,
    notes: string,
    categoryId: string,
  ): Promise<void>

  runBankSync(): Promise<void>

  createCategory(name: string, groupId: string): Promise<string>

  createCategoryGroup(name: string): Promise<string>

  updateCategoryGroup(id: string, name: string): Promise<void>
}

export interface TransactionServiceI {
  processTransactions(): Promise<void>;
}

export interface ActualAiServiceI {
  classify(): Promise<void>;

  syncAccounts(): Promise<void>
}

export interface RuleDescription {
  ruleName: string;
  conditions: {
    field: string;
    op: string;
    type?: string;
    value: string | string[];
  }[];
  categoryName: string;
  categoryId: string;
  index?: number;
}

export interface CategorySuggestion {
  name: string;
  groupName: string;
  groupIsNew: boolean;
}

export interface UnifiedResponse {
  type: 'existing' | 'new' | 'rule';
  categoryId?: string;
  ruleName?: string;
  newCategory?: CategorySuggestion;
}

export interface LlmServiceI {
  ask(prompt: string): Promise<UnifiedResponse>;
}

export interface ToolServiceI {
  getTools(): Record<string, Tool>;
  // Optional helper to run a single search outside model tool-calling.
  search?(query: string): Promise<string>;
}

// Precomputed, run-invariant prompt inputs (see PromptGenerator.createRunContext).
// Built once per run and reused for every transaction, instead of recompiling the
// template and rebuilding groupsWithCategories/rulesDescription/the payee index on
// every single transaction.
export interface PromptRunContext {
  template: (data: Record<string, unknown>) => string;
  groupsWithCategories: (APICategoryGroupEntity & {
    groupName: string;
    categories: APICategoryEntity[];
  })[];
  rulesDescription: RuleDescription[];
  payeeNameById: Map<string, string>;
  hasWebSearchTool: boolean;
}

export interface PromptGeneratorI {
  createRunContext(
    categoryGroups: APICategoryGroupEntity[],
    payees: APIPayeeEntity[],
    rules: RuleEntity[],
  ): PromptRunContext;

  generateFromContext(
    context: PromptRunContext,
    transaction: TransactionEntity,
  ): string;

  generate(
    categoryGroups: APICategoryGroupEntity[],
    transaction: TransactionEntity,
    payees: APIPayeeEntity[],
    rules: RuleEntity[],
  ): string;
}

export interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

export interface ProcessingStrategyI {
  process(
      transaction: TransactionEntity,
      response: UnifiedResponse,
      // Indexed once per run (see BatchTransactionProcessor), not the raw array — the
      // only strategy that reads this (ExistingCategoryStrategy) does an O(1)
      // .get(categoryId) instead of a linear .find() on every transaction.
      categoryById: Map<string, APICategoryEntity | APICategoryGroupEntity>,
      suggestedCategories: Map<string, {
        name: string;
        groupName: string;
        groupIsNew: boolean;
        groupId?: string;
        transactions: TransactionEntity[];
      }>
  ): Promise<void>;
  isSatisfiedBy(response: UnifiedResponse): boolean;
}
