import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { accessSubject, DirectoryService } from '@request-management/share';
import {
  ACTION_PERMISSIONS,
  ApprovalsService,
  CompanyMemberRepository,
  OPEN_STATUSES,
  OrgUnitRepository,
  RequestRepository,
  RequestsService,
  availableActions,
  toFormFields,
  toRequestAction,
  type ActionSpec,
  type RequestAction,
} from '@request-management/core-service';
import {
  ExternalActionDto,
  ExternalCreateRequestDto,
  ExternalListRequestsDto,
  ExternalSummaryDto as ExternalSummaryQueryDto,
  ExternalTypeQueryDto,
  ExternalUsersDto as ExternalUsersQueryDto,
} from './dto/request.dto';

/** Matches a uuid, so a reference can be told from a document number. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `listTypes` includes the receiving team, but `findMany` on the repository is
 * typed by the model alone, so the include does not survive into the signature.
 * Narrowed here rather than widening the repository: this is the only caller
 * that reads the relation, and the `include` two files away is what makes it
 * true.
 */
type TypeWithReceiver = Awaited<
  ReturnType<RequestsService['listTypes']>
>[number] & {
  receiverOrgUnit: { id: string; name: string } | null;
};

/**
 * The external API's orchestration — and deliberately nothing more.
 *
 * Every rule this touches already exists: `RequestsService` owns the
 * lifecycle, `ApprovalsService` owns decisions, `available-actions.ts` owns
 * what may be done. This class shapes those for a caller that has no screen —
 * it resolves a document number to an id, collapses create-then-submit into
 * one call, and hands back the fields a chatbot has to ask for.
 *
 * It holds **no** authorisation logic of its own. The acting user's principal
 * arrives already resolved (`ActingUserGuard`), and every method passes it
 * straight through, so a rule cannot apply differently here than on a screen.
 */
@Injectable()
export class RequestApiService {
  constructor(
    private readonly requests: RequestsService,
    private readonly approvals: ApprovalsService,
    private readonly requestRows: RequestRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly members: CompanyMemberRepository,
    private readonly directory: DirectoryService,
  ) {}

  /**
   * The request types this person may raise (use case step 2).
   *
   * `listTypes` already answers that — active, in their company, and allowed
   * to their part of the org chart. The filters here only narrow what it
   * returned; nothing widens it.
   */
  async listTypes(actor: Principal, query: ExternalTypeQueryDto) {
    const types = (await this.requests.listTypes(actor)) as TypeWithReceiver[];
    const term = query.q?.trim().toLowerCase();

    return types
      .filter((type) => {
        if (query.department && type.receiverOrgUnitId !== query.department) {
          return false;
        }

        if (!term) return true;

        return (
          type.code.toLowerCase().includes(term) ||
          type.name.toLowerCase().includes(term)
        );
      })
      .map((type) => ({
        code: type.code,
        name: type.name,
        sla_hours: type.slaHours,
        receiver_org_unit: type.receiverOrgUnit,
        ref_required: type.refRequired,
      }));
  }

  /**
   * Everything needed to ask a person for a request of this type (step 4).
   *
   * The schemas travel as they are stored. They carry `title`, `enum`,
   * `x-order` and `x-multiline`, which is exactly what a chatbot needs to
   * phrase its questions in the right order and offer the right options —
   * the same information the web form renders from.
   *
   * Read through `listTypes` rather than by code, so a type this person may
   * not raise reads as "not found" instead of handing out its form.
   */
  async formOf(code: string, actor: Principal) {
    const types = (await this.requests.listTypes(actor)) as TypeWithReceiver[];
    const type = types.find((candidate) => candidate.code === code);

    if (!type) {
      throw new AppError('NOT_FOUND', 'ไม่พบประเภทคำขอที่ระบุ', [
        { field: 'type_code', reason: code },
      ]);
    }

    return {
      code: type.code,
      name: type.name,
      sla_hours: type.slaHours,
      ref_required: type.refRequired,
      /** Filled by the requester, validated at submit. */
      form_schema: type.formSchema,
      /** Filled by whoever finishes the work, validated at `complete`. */
      receiver_form_schema: type.receiverFormSchema,
      required_docs: type.requiredDocs,
      /** REQ-04 — the only reasons `return` accepts for this type. */
      return_reason_codes: type.returnReasonCodes,
      /*
        The same two schemas, asked-ready. Kept beside the raw ones rather than
        replacing them: the web app renders from `form_schema`, and a caller
        that already parses it should not have to change to keep working.
      */
      form_fields: toFormFields(type.formSchema),
      receiver_form_fields: toFormFields(type.receiverFormSchema),
      receiver_org_unit: type.receiverOrgUnit,
      receiver_candidates: await this.receiverCandidates(type, actor),
    };
  }

  /**
   * Raise and submit in one call (steps 4 and 10).
   *
   * Two service calls rather than one because that is what the lifecycle is:
   * `create` writes a draft, `submit` issues the number, validates the form
   * against the type's schema and starts the clock. Collapsing them in the
   * database would mean a second submit path, and the rules would then live in
   * two places.
   *
   * Not one transaction, and that is the existing design: `submit` resolves
   * the approval chain across a service boundary and cannot join one. A
   * failure between the two leaves a draft the same person can see and finish
   * — visible and recoverable, unlike a number issued for nothing.
   */
  async createAndSubmit(
    dto: ExternalCreateRequestDto,
    actor: Principal,
    authorization: string,
  ) {
    const draft = await this.requests.create(
      {
        type_code: dto.type_code,
        form_data: dto.form_data,
        receiver_user_id: dto.receiver_user_id,
        receiver_org_unit_id: dto.receiver_org_unit_id,
        parent_request_id: dto.parent_request_id,
        ref_type: dto.ref_type,
        ref_id: dto.ref_id,
      },
      actor,
    );

    await this.requests.submit(draft.id, actor, authorization);

    return this.findByRef(draft.id, actor);
  }

  /** The person's own queues (steps 5 and 11). */
  async list(actor: Principal, query: ExternalListRequestsDto) {
    const page = await this.requests.list(actor, {
      ...query,
      view: query.view ?? 'involved',
    });

    return {
      ...page,
      data: page.data.map((row) => ({
        ...row,
        available_actions: performable(row.available_actions),
      })),
    };
  }

  /**
   * How much work there is, without listing it (G-02).
   *
   * Counted from `scopedWhere` — the same filter the list builds its page from
   * — so the number and the rows behind it cannot disagree (SCOPE-02). A
   * summary that computed its own condition would be a second visibility rule,
   * and the one it disagreed with would be the one nobody was looking at.
   */
  async summary(actor: Principal, query: ExternalSummaryQueryDto) {
    const covering = await this.approvals.coveringFor(actor);
    const filters = { ...query, view: query.view ?? 'involved' };

    const [counts, overdue] = await Promise.all([
      this.requestRows.countByStatus(
        this.requests.scopedWhere(actor, filters, covering),
      ),
      this.requestRows.countWhere(
        this.requests.scopedWhere(
          actor,
          { ...filters, overdue: true },
          covering,
        ),
      ),
    ]);

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

    /*
      `open_total` is the answer to "งานค้าง", which is not "everything".
      A closed request is still counted in `counts` — a caller asking for a
      breakdown wants the whole picture — but rolling it into the outstanding
      figure would overstate somebody's workload every time.
    */
    const open_total = OPEN_STATUSES.reduce(
      (sum, status) => sum + (counts[status] ?? 0),
      0,
    );

    return { counts, open_total, total, overdue };
  }

  /**
   * Look somebody up by name (G-03).
   *
   * Every id the API accepts — `receiver_user_id`, `assignee_user_id` — is a
   * uuid, and a person speaking to a chatbot says "คุณจารุภา". Until this
   * existed the only names an integration could resolve were the receiving
   * team of one request type, so handing work to anybody else was impossible
   * without a screen.
   *
   * The rows come from the shared {@link DirectoryService}, which is also what
   * answers `GET /users` — one query, so the two cannot disagree about who
   * exists.
   */
  async searchUsers(actor: Principal, query: ExternalUsersQueryDto) {
    const orgUnitIds =
      query.scope === 'team' ? await this.teamUnitsOf(actor) : undefined;

    return this.directory.searchUsers(accessSubject(actor), {
      ...query,
      ...(orgUnitIds ? { orgUnitIds } : {}),
    });
  }

  /**
   * This person's own group and everything under it.
   *
   * `[]` for somebody still in the รอจัดสังกัด queue, which
   * `DirectoryService` turns into "nobody" rather than "everybody" — asking
   * for a team you do not have must not answer with the whole company.
   */
  private async teamUnitsOf(actor: Principal): Promise<string[]> {
    if (!actor.orgUnitId) return [];

    return this.orgUnits.descendantIdsOf(actor.orgUnitId);
  }

  /** One request, by uuid or by document number (steps 7 and 13). */
  async findByRef(ref: string, actor: Principal) {
    return this.requests.findOne(await this.idOf(ref, actor), actor);
  }

  /** This request and everything linked to it (step 14). */
  async treeOf(ref: string, actor: Principal) {
    return this.requests.tree(await this.idOf(ref, actor), actor);
  }

  /**
   * What this person may do with this request right now (steps 8 and 14).
   *
   * The list is the flow's answer, not a menu written for one use case — see
   * `available-actions.ts`. Everything it offers will be accepted by
   * {@link perform}, because both consult the same rules.
   */
  async actionsFor(ref: string, actor: Principal) {
    const request = await this.findByRef(ref, actor);
    const approvalCase = request.approvalCases[0];

    /*
      Whether this person may decide the step the case is *currently* on —
      not any step their name appears on further down the ladder. A candidate
      on step 3 has nothing to do while step 2 is pending.
    */
    const pendingStep = approvalCase?.steps.find(
      (step) => step.stepNo === approvalCase.currentStep,
    );

    const isDecider =
      pendingStep?.status === 'pending' &&
      (pendingStep.candidateUserIds.includes(actor.userId) ||
        (pendingStep.candidateUserIds.length === 0 &&
          pendingStep.approverUserId === actor.userId));

    // `advance` exists only on a request that runs a step flow.
    const allowed = availableActions(request, actor, isDecider).filter(
      (spec) => spec.action !== 'advance' || request.flowVersionId !== null,
    );

    return {
      request_id: request.id,
      request_no: request.requestNo,
      status: request.status,
      actions: allowed
        .filter((spec) => spec.action !== 'create_child')
        .map(describe),
      flow_moves: await this.requests.flowMovesOf(request),
      /*
        Reported as a fact rather than offered as an action. `create_child` is
        in the flow's table because spawning a child is something the flow
        allows, but there is no verb to send: a child request is an ordinary
        request with a parent, raised through `POST request/requests`. It used
        to appear in `actions` and answer 400 to anyone who believed it.
      */
      can_create_child: allowed.some((spec) => spec.action === 'create_child'),
    };
  }

  /**
   * Do one of them.
   *
   * A single dispatcher rather than an endpoint per verb: the set of verbs is
   * the flow's, and it grows when the flow does. Each branch calls the service
   * method the web app calls, so the authority check, the transition check and
   * the audit entry are the same ones — this method adds none of its own.
   */
  async perform(
    ref: string,
    action: string,
    dto: ExternalActionDto,
    actor: Principal,
    authorization: string,
  ) {
    const known = toRequestAction(action);

    if (!known) {
      throw new AppError('VALIDATION_FAILED', 'ไม่รู้จัก action ที่ระบุ', [
        { field: 'action', reason: action },
      ]);
    }

    /*
      The acting user's own gate, which the controller cannot declare: one
      route, fourteen verbs, a different permission each. `ActingPolicyGuard`
      handles every other route from a decorator; this is the same check made
      here because the permission is only known once the verb is parsed.

      It runs before `idOf`, so a person without the permission learns nothing
      about whether the reference exists — SCOPE-03's reasoning applied to a
      permission failure rather than a company boundary.
    */
    this.assertMayPerform(known, actor);

    const id = await this.idOf(ref, actor);

    switch (known) {
      case 'receive':
        return this.requests.receive(id, actor);
      case 'assign':
        return this.requests.assign(
          id,
          {
            assignee_user_id: required(
              dto.assignee_user_id,
              'assignee_user_id',
            ),
          },
          actor,
        );
      case 'hold':
        return this.requests.hold(
          id,
          { reason: required(dto.reason, 'reason') },
          actor,
        );
      case 'resume':
        return this.requests.resume(id, { note: dto.note }, actor);
      case 'complete':
        return this.requests.complete(id, actor, authorization, {
          receiver_form_data: dto.receiver_form_data,
        });
      case 'advance':
        return this.requests.advance(
          id,
          { to_step: required(dto.to_step, 'to_step') },
          actor,
          authorization,
        );
      case 'return':
        return this.requests.returnToRequester(
          id,
          {
            reason_code: required(dto.reason_code, 'reason_code'),
            note: dto.note,
          },
          actor,
        );
      case 'cancel':
        return this.requests.cancel(
          id,
          { reason: required(dto.reason, 'reason') },
          actor,
        );
      case 'close':
        return this.requests.close(id, actor, { note: dto.note });
      case 'comment':
        return this.requests.addComment(
          id,
          { body: required(dto.body, 'body') },
          actor,
        );
      case 'submit':
      case 'resubmit':
        return this.resubmit(id, dto, actor, authorization);
      case 'approve':
      case 'reject':
      case 'send_back':
        return this.decide(id, known, dto, actor);
      case 'create_child':
        /*
          Refused here on purpose. A child request is a *new* request with its
          own type, form and receiver, so it goes to `POST request/requests`
          with `parent_request_id` — the same validation, the same document
          number, the same submit. Accepting a second, thinner creation path
          here is how the two would drift.
        */
        throw new AppError(
          'VALIDATION_FAILED',
          'สร้างคำขอลูกด้วย POST request/requests พร้อมระบุ parent_request_id',
          [{ field: 'action', reason: 'create_child' }],
        );
    }
  }

  // --- internals ----------------------------------------------------------

  /**
   * The permission this verb needs of the person sending it.
   *
   * Read from {@link ACTION_PERMISSIONS} rather than listed here, so the
   * dispatcher and the screens' routes cannot disagree about who may hold a
   * request or decide an approval.
   *
   * `hasAuthority` inside `RequestsService` still applies afterwards and asks
   * the other question — whether this person is the requester, the carrier or
   * an approver *on this request*. Neither check replaces the other: holding
   * `request.complete` does not make somebody the carrier of every ticket.
   */
  private assertMayPerform(action: RequestAction, actor: Principal) {
    const required = ACTION_PERMISSIONS[action];

    if (!actor.permissions.includes(required)) {
      throw new AppError(
        'FORBIDDEN',
        'ผู้ใช้ที่ระบุใน X-Acting-User ไม่มีสิทธิ์ทำรายการนี้',
        [
          { field: 'action', reason: action },
          { field: 'permission', reason: required },
        ],
      );
    }
  }

  /**
   * Applies the corrected form, then submits.
   *
   * The correction is a separate write because `update` is what validates a
   * change to a draft or a returned request; `submit` validates the whole form
   * against the schema afterwards either way.
   */
  private async resubmit(
    id: string,
    dto: ExternalActionDto,
    actor: Principal,
    authorization: string,
  ) {
    if (dto.form_data) {
      await this.requests.update(id, { form_data: dto.form_data }, actor);
    }

    await this.requests.submit(id, actor, authorization);

    return this.requests.findOne(id, actor);
  }

  /**
   * A decision on the request's current approval case.
   *
   * The case id is read from the request rather than taken from the caller: a
   * chatbot holds a request number and nothing else, and asking it to carry an
   * approval case id would be asking it to model the approval engine.
   */
  private async decide(
    id: string,
    action: 'approve' | 'reject' | 'send_back',
    dto: ExternalActionDto,
    actor: Principal,
  ) {
    const request = await this.requests.findOne(id, actor);
    const approvalCase = request.approvalCases[0];

    if (!approvalCase || request.status !== 'pending_approval') {
      throw new AppError(
        'REQ_STATE_INVALID',
        'คำขอนี้ไม่ได้อยู่ระหว่างรอการอนุมัติ',
        [{ field: 'status', reason: request.status }],
      );
    }

    const decision =
      action === 'approve'
        ? 'approve'
        : action === 'reject'
          ? 'reject'
          : 'return';

    return this.approvals.decide(
      approvalCase.id,
      { decision, note: required(dto.note, 'note') },
      actor,
    );
  }

  /** A uuid as given; a document number looked up in the caller's company. */
  private async idOf(ref: string, actor: Principal): Promise<string> {
    if (UUID.test(ref)) return ref;

    const id = await this.requestRows.findIdByNumber(
      ref,
      actor.activeCompanyId,
    );

    // SCOPE-03: a number from another company is "not found", never "denied".
    if (!id) {
      throw new AppError('NOT_FOUND', 'ไม่พบคำขอที่ระบุ', [
        { field: 'request', reason: ref },
      ]);
    }

    return id;
  }

  /**
   * Who this type's work can be handed to.
   *
   * The receiving team and everything under it — the type names a ฝ่าย while
   * the people who take the work sit in the แผนก and ตำแหน่ง beneath it, so
   * offering only direct members would offer nobody.
   *
   * A type with no receiving team returns an empty list rather than the whole
   * company: a chatbot asked to choose from four hundred names is a chatbot
   * that will choose wrongly. The caller passes a `receiver_user_id` it got
   * from elsewhere in that case.
   */
  private async receiverCandidates(
    type: { receiverOrgUnitId: string | null; receiverUserId: string | null },
    actor: Principal,
  ) {
    // A type with a fixed receiver accepts nobody else, so offer nobody else.
    if (type.receiverUserId) {
      return this.members.findActiveByIds(
        [type.receiverUserId],
        actor.activeCompanyId,
      );
    }

    if (!type.receiverOrgUnitId) return [];

    const units = await this.orgUnits.descendantIdsOf(type.receiverOrgUnitId);

    return this.members.findInUnits(units, actor.activeCompanyId);
  }
}

/** Turns a spec into the shape a caller reads — snake_case, no internals. */
/**
 * The actions a caller may actually send, out of what the flow allows.
 *
 * `create_child` is the whole of the difference, and it is not an oversight in
 * the flow's table: the table describes what may happen to a request, and
 * spawning a child may. What it is not is a verb this API accepts, so offering
 * it here would be offering a button that answers 400 — the failure
 * `available-actions.ts` names as worse than offering nothing, because the
 * caller has already told somebody it would work.
 */
function performable(actions: readonly string[] = []): string[] {
  return actions.filter((action) => action !== 'create_child');
}

function describe(spec: ActionSpec) {
  return {
    action: spec.action,
    fields: spec.fields.map((field) => ({
      name: field.name,
      required: field.required,
      ...(field.source ? { source: field.source } : {}),
    })),
  };
}

/** A field the chosen action cannot do without. */
function required<T>(value: T | undefined, field: string): T {
  if (value === undefined || value === null || value === '') {
    throw new AppError('VALIDATION_FAILED', `ต้องระบุ ${field}`, [
      { field, reason: 'required' },
    ]);
  }

  return value;
}
