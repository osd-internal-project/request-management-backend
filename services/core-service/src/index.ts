// --- requests -------------------------------------------------------------
export { RequestsModule } from './requests/requests.module';
export { RequestsService } from './requests/requests.service';
export { RequestRepository } from './requests/request.repository';
export { toFormFields } from './requests/form-schema';
export { CreateIntegrationRequestDto } from './requests/dto/request.dto';
export { OPEN_STATUSES } from './requests/request-state-machine';
export {
  ACTIONS,
  ACTION_PERMISSIONS,
  availableActions,
  toRequestAction,
} from './requests/available-actions';
export type { ActionSpec, RequestAction } from './requests/available-actions';

// --- approvals ------------------------------------------------------------
export { ApprovalsModule } from './approvals/approvals.module';
export { ApprovalsService } from './approvals/approvals.service';
export { OpenCaseDto } from './approvals/dto/approval.dto';

// --- org chart ------------------------------------------------------------
export { AccessModule } from './access/access.module';
export { OrgUnitRepository } from './access/org-unit.repository';
export { CompanyMemberRepository } from './access/company-member.repository';

// --- caller resolution ----------------------------------------------------
export { PrincipalModule } from './principal/principal.module';
export { RemotePrincipalService } from './principal/remote-principal.service';
export { RemotePrincipalGuard } from './principal/remote-principal.guard';
export {
  API_KEY_PREFIX,
  ApiKeyService,
  CurrentApiKey,
  getApiKey,
  setApiKey,
} from './principal/api-key.service';
export type {
  ApiKeyContext,
  ResolvedApiKey,
} from './principal/api-key.service';

// --- SCOPE-04 masking (registered in every service, or it is not masking) --
export { SensitiveReadAuditRecorder } from './policy/sensitive-read.recorder';

// --- CRM ------------------------------------------------------------------
export { CrmModule } from './crm/crm.module';
export { CustomersService } from './crm/customers.service';
export { CustomerImportService } from './crm/customer-import.service';
export { CrmAdminService } from './crm/crm-admin.service';
export { LeadsService } from './crm/leads.service';
export { LeadImportService } from './crm/lead-import.service';
export { LeadStatusService } from './crm/lead-status.service';
export { LeadIntakeService } from './crm/lead-intake.service';
export { LeadWorkflowService } from './crm/lead-workflow.service';
export { OpportunitiesService } from './crm/opportunities.service';
export { OpportunityActivitiesService } from './crm/opportunity-activities.service';
export { SaleOrdersService } from './crm/sale-orders.service';
export { QuotationsService } from './crm/quotations.service';
export * from './crm/dto/customer.dto';
export * from './crm/dto/sales.dto';
export * from './crm/dto/quotation.dto';
export * from './crm/dto/lead-intake.dto';
export * from './crm/dto/lead-workflow.dto';
