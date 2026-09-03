-- Workflow เป็น configuration (3 ก.ย. 2569).
--
-- §7.1 gives all forty-odd request types one route: `REQUEST_TRANSITIONS` in
-- `request-state-machine.ts`, eleven statuses shared by everything. Wanting a
-- type with its own steps, its own form per step, and its own buttons meant
-- editing that table — which changes every other type at the same time.
--
-- These tables make the route per-type and editable from a screen. They are the
-- source of truth; the BPMN deployed to Flowable is *generated* from them at
-- publish, so nobody authors XML by hand and the engine holds a projection of
-- these rows rather than a second opinion.
--
-- **Nothing changes behaviour yet.** `request_types.workflowMode` defaults to
-- `legacy` and no row is switched, so every type keeps travelling the state
-- machine. Moving a type is a later, deliberate act — and it needs PO sign-off,
-- because "statuses are configuration" contradicts §7.1 more than the three
-- amendments already declared in `request-state-machine.ts` put together.
--
-- `workflow_states.phase` is what keeps the rest of the system standing: every
-- state maps onto one of §7.1's eleven statuses and that is still what
-- `requests.status` is set to, so SLA, the bottleneck report and every §16
-- screen keep reading the column they always read.

CREATE TYPE "WorkflowMode" AS ENUM ('legacy', 'flowable');
CREATE TYPE "WorkflowDefinitionStatus" AS ENUM ('draft', 'published', 'retired');
CREATE TYPE "WorkflowStateKind" AS ENUM ('user_task', 'approval', 'end');

ALTER TABLE "request_types"
    ADD COLUMN "workflowMode" "WorkflowMode" NOT NULL DEFAULT 'legacy';

-- Names the step precisely; `status` above it stays the §7.1 phase.
ALTER TABLE "requests" ADD COLUMN "workflowStateKey" TEXT;

CREATE TABLE "workflow_definitions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "requestTypeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "WorkflowDefinitionStatus" NOT NULL DEFAULT 'draft',
    -- Generated at publish and kept, not rebuilt on demand: the exact XML a
    -- running instance was deployed from has to be readable when its behaviour
    -- is questioned.
    "bpmnXml" TEXT,
    "flowableDeploymentId" TEXT,
    "flowableProcessKey" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- Versioned per company, and a published version is never edited — editing
-- means publishing N+1. Same rule as `approval_matrices`, same reason: a
-- request already running keeps the route it started on.
CREATE UNIQUE INDEX "workflow_definitions_requestTypeId_companyId_version_key"
    ON "workflow_definitions"("requestTypeId", "companyId", "version");

CREATE INDEX "workflow_definitions_companyId_status_idx"
    ON "workflow_definitions"("companyId", "status");

CREATE TABLE "workflow_states" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    -- Stable identifier and the BPMN element id.
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- The §7.1 status this state reports as. See the header.
    "phase" "RequestStatus" NOT NULL,
    "kind" "WorkflowStateKind" NOT NULL DEFAULT 'user_task',
    "formSchema" JSONB,
    -- Overrides the type's SLA for time spent here; null inherits.
    "slaHours" INTEGER,
    "isStart" BOOLEAN NOT NULL DEFAULT false,
    -- Draw order on the admin screen, not semantics. The route comes from
    -- `workflow_actions` and nowhere else.
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_states_definitionId_key_key"
    ON "workflow_states"("definitionId", "key");

CREATE TABLE "workflow_actions" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "fromStateKey" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "toStateKey" TEXT NOT NULL,
    -- The Thai text on the button.
    "label" TEXT NOT NULL,
    -- A value of the `Authority` union in `requests/available-actions.ts`. Not
    -- a second permission system: `hasAuthority` stays the one implementation
    -- and the handler re-checks it however the action was offered (ROLE-01).
    "authority" TEXT NOT NULL,
    "formSchema" JSONB,
    -- Guard on workflow variables; becomes the BPMN sequence-flow condition.
    "condition" TEXT,
    "confirmRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_actions_pkey" PRIMARY KEY ("id")
);

-- One button per action key per state: two rows would make "what does this
-- button do" answerable two ways.
CREATE UNIQUE INDEX "workflow_actions_definitionId_fromStateKey_actionKey_key"
    ON "workflow_actions"("definitionId", "fromStateKey", "actionKey");

CREATE INDEX "workflow_actions_definitionId_toStateKey_idx"
    ON "workflow_actions"("definitionId", "toStateKey");

-- The data flow an administrator sets: which answer becomes which workflow
-- variable, and which column the callback writes it back to.
--
-- `targetColumn` is checked against an allow-list at publish. Without that a
-- workflow could be configured to overwrite `status`, `requestNo` or
-- `requesterId` — the columns the permission and numbering models rest on —
-- from a form field.
CREATE TABLE "workflow_data_maps" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "sourceField" TEXT NOT NULL,
    "variableName" TEXT NOT NULL,
    "targetColumn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_data_maps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_data_maps_actionId_sourceField_key"
    ON "workflow_data_maps"("actionId", "sourceField");

-- The join between a row here and a process instance in Flowable.
--
-- `currentStateKey` mirrors what the engine says so screens and the action list
-- can be answered without an HTTP call per page view. The engine stays
-- authoritative about where the instance actually is; the callback is what
-- keeps this row honest.
CREATE TABLE "workflow_instances" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "flowableProcessInstanceId" TEXT NOT NULL,
    "currentStateKey" TEXT NOT NULL,
    "currentTaskId" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_instances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workflow_instances_requestId_key"
    ON "workflow_instances"("requestId");

CREATE UNIQUE INDEX "workflow_instances_flowableProcessInstanceId_key"
    ON "workflow_instances"("flowableProcessInstanceId");

CREATE INDEX "workflow_instances_definitionId_idx"
    ON "workflow_instances"("definitionId");

ALTER TABLE "workflow_definitions"
    ADD CONSTRAINT "workflow_definitions_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workflow_definitions"
    ADD CONSTRAINT "workflow_definitions_requestTypeId_fkey"
    FOREIGN KEY ("requestTypeId") REFERENCES "request_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cascade from the definition down: states, actions and their data maps are
-- parts of one version, not records of their own. A published version is never
-- deleted (`retired` is what replaces deletion), so this only ever fires on a
-- draft being discarded.
ALTER TABLE "workflow_states"
    ADD CONSTRAINT "workflow_states_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "workflow_definitions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_actions"
    ADD CONSTRAINT "workflow_actions_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "workflow_definitions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_actions"
    ADD CONSTRAINT "workflow_actions_definitionId_fromStateKey_fkey"
    FOREIGN KEY ("definitionId", "fromStateKey")
    REFERENCES "workflow_states"("definitionId", "key")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_data_maps"
    ADD CONSTRAINT "workflow_data_maps_actionId_fkey"
    FOREIGN KEY ("actionId") REFERENCES "workflow_actions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The request is gone only if it was never real; a workflow instance without
-- its request is not a record of anything.
ALTER TABLE "workflow_instances"
    ADD CONSTRAINT "workflow_instances_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "requests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_instances"
    ADD CONSTRAINT "workflow_instances_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "workflow_definitions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
