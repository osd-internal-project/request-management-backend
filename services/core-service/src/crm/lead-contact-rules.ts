/**
 * ผู้ติดต่อของ Lead (12 พ.ย. 2569) — the primary contact is four columns on
 * `leads`; `lead_contacts` holds everyone after the first. These pure
 * functions are the one place that reads the two as a single list.
 */

/** The id the API uses for the primary contact, which has no row of its own. */
export const PRIMARY_CONTACT_ID = 'primary';

export interface LeadPrimaryColumns {
  contactName: string | null;
  contactPosition: string | null;
  phone: string | null;
  email: string | null;
}

export interface LeadContactRow {
  id: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
}

export interface LeadContactView {
  id: string;
  /** `null` on a primary contact that has only a phone or an email. */
  name: string | null;
  position: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
}

/** A lead has a primary contact once any way of reaching someone is filled in. */
export function hasPrimaryContact(lead: LeadPrimaryColumns): boolean {
  return Boolean(
    lead.contactName?.trim() || lead.phone?.trim() || lead.email?.trim(),
  );
}

/** Primary first, then the others in the order they were added. */
export function contactsOf(
  lead: LeadPrimaryColumns,
  rows: LeadContactRow[],
): LeadContactView[] {
  const primary: LeadContactView[] = hasPrimaryContact(lead)
    ? [
        {
          id: PRIMARY_CONTACT_ID,
          name: lead.contactName,
          position: lead.contactPosition,
          phone: lead.phone,
          email: lead.email,
          isPrimary: true,
        },
      ]
    : [];

  return [
    ...primary,
    ...rows.map((row) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      phone: row.phone,
      email: row.email,
      isPrimary: false,
    })),
  ];
}
