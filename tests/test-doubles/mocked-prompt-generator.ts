import { APICategoryGroupEntity, APIPayeeEntity } from '@actual-app/core/src/server/api-models';
import { RuleEntity, TransactionEntity } from '@actual-app/core/src/types/models';
import { PromptGeneratorI, PromptRunContext } from '../../src/types';

export default class MockedPromptGenerator implements PromptGeneratorI {
  createRunContext(
    _categoryGroups: APICategoryGroupEntity[],
    _payees: APIPayeeEntity[],
    _rules: RuleEntity[],
  ): PromptRunContext {
    return {
      template: () => 'mocked prompt',
      groupsWithCategories: [],
      rulesDescription: [],
      payeeNameById: new Map(),
      hasWebSearchTool: false,
    };
  }

  generateFromContext(
    _context: PromptRunContext,
    _transaction: TransactionEntity,
  ): string {
    return 'mocked prompt';
  }

  generate(
    _categoryGroups: APICategoryGroupEntity[],
    _transaction: TransactionEntity,
    _payees: APIPayeeEntity[],
    _rules?: RuleEntity[],
  ): string {
    return 'mocked prompt';
  }
}
