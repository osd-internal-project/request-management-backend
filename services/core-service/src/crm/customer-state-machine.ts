import { CustomerStatus } from '@prisma/client';
import { AppError } from '@request-management/share';

/**
 * CM-04 — the customer lifecycle, as data.
 *
 * ```
 * draft ──activate──▶ active ──suspend──▶ suspended
 *   │                  │  ▲                 │    │
 *   │        deactivate│  └────reactivate───┘    │deactivate
 *   ▼                  ▼                         ▼
 * inactive ◀───────────┴─────────────────────────┘
 *   │
 *   └──reactivate──▶ active
 * ```
 *
 * **KYC is not a state.** The PO confirmed (8 ก.ย. 2569) that KYC binds to
 * the product, not the customer: a customer is usable the moment it exists,
 * and `kycVerified` is a flag set by the "เปิดลูกค้าใหม่ (KYC)" request's
 * approval callback (ชุดงาน B). A `pending_kyc` status would block every
 * customer who never touches a KYC product, which is most of them.
 *
 * `inactive` is the no-hard-delete rule in state form: it always requires a
 * reason, the row keeps everything it had, and `inactive → active` exists so
 * a retired customer who comes back is reactivated — the CM-03 duplicate
 * check points at this row precisely so nobody registers them twice.
 */
export const CUSTOMER_TRANSITIONS: Readonly<
  Record<CustomerStatus, readonly CustomerStatus[]>
> = {
  // A draft may be finished or abandoned — abandoning still needs a reason,
  // because the row stays findable like every other retirement.
  draft: ['active', 'inactive'],
  active: ['suspended', 'inactive'],
  suspended: ['active', 'inactive'],
  inactive: ['active'],
};

/** Statuses in which the customer participates in new business. */
export const USABLE_STATUSES: readonly CustomerStatus[] = ['active'];

/** Statuses the CM-06 Odoo sync pushes — never drafts. */
export const SYNCED_STATUSES: readonly CustomerStatus[] = [
  'active',
  'suspended',
  'inactive',
];

export function canTransitionCustomer(
  from: CustomerStatus,
  to: CustomerStatus,
): boolean {
  return CUSTOMER_TRANSITIONS[from].includes(to);
}

/**
 * Guards a status change. Throws `CRM_CUSTOMER_STATE_INVALID` (409) rather
 * than returning false, so a caller cannot forget to check — the CM-04 AC
 * demands transitions outside the table be impossible through every channel,
 * including direct API calls.
 */
export function assertCustomerTransition(
  from: CustomerStatus,
  to: CustomerStatus,
): void {
  if (!canTransitionCustomer(from, to)) {
    throw new AppError(
      'CRM_CUSTOMER_STATE_INVALID',
      'ไม่สามารถเปลี่ยนสถานะลูกค้าจากสถานะปัจจุบันได้',
      [{ field: 'status', reason: `${from} → ${to}` }],
    );
  }
}
