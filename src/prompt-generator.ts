import { APIPayeeEntity, APICategoryGroupEntity } from '@actual-app/core/src/server/api-models';
import { RuleEntity, TransactionEntity } from '@actual-app/core/src/types/models';
import handlebars from './handlebars-helpers';
import {
  PromptGeneratorI, PromptRunContext, RuleDescription,
} from './types';
import PromptTemplateException from './exceptions/prompt-template-exception';
import { isToolEnabled } from './config';
import { transformRulesToDescriptions } from './utils/rule-utils';

function buildGroupsWithCategories(categoryGroups: APICategoryGroupEntity[]) {
  // Ensure each category group has its categories property
  return categoryGroups.map((group) => ({
    ...group,
    groupName: group.name,
    categories: group.categories ?? [],
  }));
}

function compileTemplate(promptTemplate: string): (data: Record<string, unknown>) => string {
  try {
    return handlebars.compile(promptTemplate);
  } catch {
    console.error('Error generating prompt. Check syntax of your template.');
    throw new PromptTemplateException('Error generating prompt. Check syntax of your template.');
  }
}

class PromptGenerator implements PromptGeneratorI {
  private readonly promptTemplate: string;

  constructor(
    promptTemplate: string,
  ) {
    this.promptTemplate = promptTemplate;
  }

  /**
   * Precomputes everything the prompt needs that does NOT vary per transaction:
   * compiling the handlebars template, building groupsWithCategories, rendering the
   * rules descriptions, indexing payees by id, and resolving whether web search is
   * enabled. All of that used to happen fresh inside generate() on every single
   * transaction. Safe to compute once per run and reuse for every transaction in it
   * because of the plan/mutate separation (see PERFORMANCE.md B1):
   * TransactionService.processTransactions() runs the full classification loop to
   * completion, with categoryGroups/payees/rules held constant throughout, BEFORE any
   * category or group gets created — nothing in the loop this context is used by can
   * change categoryGroups, payees, or rules mid-run.
   */
  public createRunContext(
    categoryGroups: APICategoryGroupEntity[],
    payees: APIPayeeEntity[],
    rules: RuleEntity[],
  ): PromptRunContext {
    const template = compileTemplate(this.promptTemplate);
    const groupsWithCategories = buildGroupsWithCategories(categoryGroups);
    const rulesDescription: RuleDescription[] = transformRulesToDescriptions(
      rules,
      groupsWithCategories,
      payees,
    );
    const payeeNameById = new Map(payees.map((payee) => [payee.id, payee.name]));
    const hasWebSearchTool = typeof isToolEnabled('webSearch') === 'boolean' && isToolEnabled('webSearch');

    return {
      template, groupsWithCategories, rulesDescription, payeeNameById, hasWebSearchTool,
    };
  }

  /**
   * The hot path: renders one transaction against a context built once by
   * createRunContext(), instead of recompiling the template and rebuilding
   * groupsWithCategories/rulesDescription/the payee index on every call.
   */
  public generateFromContext(
    context: PromptRunContext,
    transaction: TransactionEntity,
  ): string {
    const payeeName = transaction.payee ? context.payeeNameById.get(transaction.payee) : undefined;

    try {
      return context.template({
        categoryGroups: context.groupsWithCategories,
        rules: context.rulesDescription,
        amount: Math.abs(transaction.amount),
        type: transaction.amount > 0 ? 'Income' : 'Outcome',
        description: transaction.notes ?? '',
        payee: payeeName ?? '',
        importedPayee: transaction.imported_payee ?? '',
        date: transaction.date ?? '',
        cleared: transaction.cleared,
        reconciled: transaction.reconciled,
        hasWebSearchTool: context.hasWebSearchTool,
      });
    } catch {
      console.error('Error generating prompt. Check syntax of your template.');
      throw new PromptTemplateException('Error generating prompt. Check syntax of your template.');
    }
  }

  /**
   * Back-compat single-shot path: recompiles the template and rebuilds everything
   * from scratch on every call, same as before this refactor. Kept so existing
   * callers/tests don't need to change; production's hot path (TransactionProcessor,
   * via BatchTransactionProcessor) uses createRunContext()/generateFromContext()
   * instead. Implemented in terms of those two so there's exactly one rendering code
   * path, not two to keep in sync.
   */
  generate(
    categoryGroups: APICategoryGroupEntity[],
    transaction: TransactionEntity,
    payees: APIPayeeEntity[],
    rules: RuleEntity[],
  ): string {
    const context = this.createRunContext(categoryGroups, payees, rules);
    return this.generateFromContext(context, transaction);
  }
}

export default PromptGenerator;
