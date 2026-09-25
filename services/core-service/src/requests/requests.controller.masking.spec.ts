import { SENSITIVE_RESOURCE_KEY } from '@request-management/share';
import { RequestsController } from './requests.controller';

function resourceOf(name: string): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    RequestsController.prototype,
    name,
  )?.value as object;
  return Reflect.getMetadata(SENSITIVE_RESOURCE_KEY, handler);
}

/**
 * CD-127 — the list fed the customer 360° requests tab and งานค้างของฉัน
 * with every row's margin in the clear; the detail route masked DSC rules
 * only. Both now mask each row by its own type.
 */
describe('CD-127 request routes mask by the row’s own type', () => {
  it.each(['list', 'findOne'])('%s declares request:{typeCode}', (name) => {
    expect(resourceOf(name)).toBe('request:{typeCode}');
  });
});
