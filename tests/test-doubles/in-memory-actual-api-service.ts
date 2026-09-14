import {
  APIAccountEntity,
  APICategoryEntity,
  APICategoryGroupEntity,
  APIPayeeEntity,
} from '@actual-app/core/src/server/api-models';
import { RuleEntity, TransactionEntity } from '@actual-app/core/src/types/models';
import { ActualApiServiceI } from '../../src/types';
import metrics from '../../src/utils/metrics';

export default class InMemoryActualApiService implements ActualApiServiceI {
  private categoryGroups: APICategoryGroupEntity[] = [];

  private categories: (APICategoryEntity | APICategoryGroupEntity)[] = [];

  private payees: APIPayeeEntity[] = [];

  private accounts: APIAccountEntity[] = [];

  private transactions: TransactionEntity[] = [];

  private wasBankSyncRan = false;

  // Monotonic, not Date.now(): concurrent creates (the real CategorySuggester fans
  // out with Promise.all) can land in the same millisecond and previously minted
  // colliding ids.
  private nextId = 0;

  private rules: RuleEntity[] = [];

  private readonly isDryRun: boolean;

  constructor(isDryRun = false) {
    this.isDryRun = isDryRun;
  }

  async initializeApi(): Promise<void> {
    // Initialize the API (mock implementation)
  }

  async shutdownApi(): Promise<void> {
    // Shutdown the API (mock implementation)
  }

  async getCategoryGroups(): Promise<APICategoryGroupEntity[]> {
    metrics.incr('actual_read_calls');
    return Promise.resolve(this.categoryGroups);
  }

  setCategoryGroups(categoryGroups: APICategoryGroupEntity[]): void {
    this.categoryGroups = categoryGroups;
  }

  async getCategories(): Promise<(APICategoryEntity | APICategoryGroupEntity)[]> {
    metrics.incr('actual_read_calls');
    return Promise.resolve(this.categories);
  }

  setCategories(categories: (APICategoryEntity | APICategoryGroupEntity)[]): void {
    this.categories = categories;
  }

  async getAccounts(): Promise<APIAccountEntity[]> {
    metrics.incr('actual_read_calls');
    return Promise.resolve(this.accounts);
  }

  setAccounts(accounts: APIAccountEntity[]): void {
    this.accounts = accounts;
  }

  async getPayees(): Promise<APIPayeeEntity[]> {
    metrics.incr('actual_read_calls');
    return Promise.resolve(this.payees);
  }

  setPayees(payees: APIPayeeEntity[]): void {
    this.payees = payees;
  }

  async getTransactions(): Promise<TransactionEntity[]> {
    metrics.incr('actual_read_calls');
    return Promise.resolve(this.transactions);
  }

  setTransactions(transactions: TransactionEntity[]): void {
    this.transactions = transactions;
  }

  async updateTransactionNotes(id: string, notes: string): Promise<void> {
    if (this.isDryRun) {
      return Promise.resolve();
    }
    return metrics.timeAsync('transaction_update_ms', async () => new Promise<void>((resolve) => {
      const transaction = this.transactions.find((t) => t.id === id);

      if (!transaction) {
        throw new Error(`Transaction with id ${id} not found`);
      }
      transaction.notes = notes;
      resolve();
    }));
  }

  async updateTransactionNotesAndCategory(
    id: string,
    notes: string,
    categoryId: string,
  ): Promise<void> {
    if (this.isDryRun) {
      return Promise.resolve();
    }
    return metrics.timeAsync('transaction_update_ms', async () => new Promise<void>((resolve) => {
      const transaction = this.transactions.find((t) => t.id === id);
      if (!transaction) {
        throw new Error(`Transaction with id ${id} not found`);
      }
      transaction.notes = notes;
      transaction.category = categoryId;
      resolve();
    }));
  }

  async runBankSync(): Promise<void> {
    this.wasBankSyncRan = true;
    return Promise.resolve();
  }

  public getWasBankSyncRan(): boolean {
    return this.wasBankSyncRan;
  }

  async createCategory(name: string, groupId: string): Promise<string> {
    return metrics.timeAsync('category_creation_ms', async () => {
      this.nextId += 1;
      const categoryId = `cat-${this.nextId}`;
      const newCategory: APICategoryEntity = {
        id: categoryId,
        name,
        group_id: groupId,
        is_income: false,
      };

      this.categories.push(newCategory);

      // Update the category group to include this category
      const groupIndex = this.categoryGroups.findIndex((group) => group.id === groupId);
      if (groupIndex >= 0) {
        if (!this.categoryGroups[groupIndex].categories) {
          this.categoryGroups[groupIndex].categories = [];
        }
        this.categoryGroups[groupIndex].categories.push(newCategory);
      }

      metrics.incr('categories_created');
      return categoryId;
    });
  }

  async createCategoryGroup(name: string): Promise<string> {
    return metrics.timeAsync('category_creation_ms', async () => {
      this.nextId += 1;
      const groupId = `group-${this.nextId}`;
      const newGroup: APICategoryGroupEntity = {
        id: groupId,
        name,
        is_income: false,
        categories: [],
      };

      this.categoryGroups.push(newGroup);
      this.categories.push(newGroup);
      metrics.incr('groups_created');

      return groupId;
    });
  }

  async updateCategoryGroup(id: string, name: string): Promise<void> {
    const groupIndex = this.categoryGroups.findIndex((group) => group.id === id);
    if (groupIndex >= 0) {
      this.categoryGroups[groupIndex].name = name;
    }

    // Also update in the categories array
    const categoryIndex = this.categories.findIndex((cat) => cat.id === id);
    if (categoryIndex >= 0) {
      this.categories[categoryIndex].name = name;
    }

    return Promise.resolve();
  }

  async getRules(): Promise<RuleEntity[]> {
    metrics.incr('actual_read_calls');
    return Promise.resolve(this.rules);
  }

  async getPayeeRules(_payeeId: string): Promise<RuleEntity[]> {
    return Promise.resolve([]);
  }

  setRules(rules: RuleEntity[]): void {
    this.rules = rules;
  }
}
