import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import { missingBindings } from './form-binding';

/** A module that reads a request type's form through `x-bind`. */
export interface FormBindingRule {
  readonly target: string;
  /** What to call the module in the error an admin reads, e.g. `การเบิก`. */
  readonly label: string;
  /** The type codes this module reads, in that company — or in any company when none is given. */
  readonly typeCodes: (companyId?: string) => Promise<readonly string[]>;
  readonly required: (
    typeCode: string,
    companyId?: string,
  ) => Promise<readonly string[]> | readonly string[];
}

/**
 * Refuses a form that drops a field another module depends on, when the admin saves it —
 * not later, when the module reads an empty value. Types no module registered are never checked.
 */
@Injectable()
export class FormBindingRegistry {
  private readonly rules: FormBindingRule[] = [];

  register(rule: FormBindingRule): void {
    this.rules.push(rule);
  }

  async assertBound(typeCode: string, schema: unknown, companyId?: string): Promise<void> {
    for (const rule of this.rules) {
      if (!(await rule.typeCodes(companyId)).includes(typeCode)) continue;
      const missing = missingBindings(schema, rule.target, await rule.required(typeCode, companyId));
      if (!missing.length) continue;
      throw new AppError(
        'VALIDATION_FAILED',
        `ฟอร์มนี้ต้องมีช่องที่${rule.label}ใช้ (ป้าย x-bind) ให้ครบ: ${missing.join(', ')}`,
        missing.map((path) => ({ field: 'x-bind', reason: `${rule.target}.${path}` })),
      );
    }
  }
}
