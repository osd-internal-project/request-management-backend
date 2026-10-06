// --- requests -------------------------------------------------------------
export { RequestsModule } from './requests/requests.module';
export { RequestsService } from './requests/requests.service';
export { RequestRepository } from './requests/request.repository';
export { toFormFields } from './requests/form-schema';
export {
  CreateIntegrationRequestDto,
  ListRequestsQueryDto,
} from './requests/dto/request.dto';
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
// CD-269 — a campaign's public form and the Lead Ads webhook
export { CampaignLeadIntakeService } from './crm/campaign-lead-intake.service';
export { LeadWorkflowService } from './crm/lead-workflow.service';
export { OpportunitiesService } from './crm/opportunities.service';
export { OpportunityActivitiesService } from './crm/opportunity-activities.service';
export { NegotiationsService } from './crm/negotiations.service';
export { PhoneReservationsService } from './crm/phone-reservations.service';
export { HandoversService } from './crm/handovers.service';
export { KycService } from './crm/kyc.service';
export { ContractsService } from './crm/contracts.service';
export { SalesReportService } from './crm/sales-report.service';
export { CrmDashboardService } from './crm/crm-dashboard.service';
export { SalesTargetsService } from './crm/sales-targets.service';
export { CampaignsService } from './crm/campaigns.service';
export { TargetAccountsService } from './crm/target-accounts.service';
export { CustomerIntakeService } from './crm/customer-intake.service';
export {
  IntakeSubmissionDto,
  INTAKE_CHANNELS,
  type IntakeChannelCode,
} from './crm/dto/customer-intake.dto';
export { CustomerInvoicesService } from './crm/customer-invoices.service';
export { SaleOrdersService } from './crm/sale-orders.service';
export { QuotationsService } from './crm/quotations.service';
export { QuotationPrintService } from './crm/quotation-print.service';
export * from './crm/dto/customer.dto';
export * from './crm/dto/sales.dto';
export * from './crm/dto/quotation.dto';
export * from './crm/dto/lead-intake.dto';
export * from './crm/dto/lead-workflow.dto';

// --- after the deal: Pre-Sales → Legal → PM → Delivery → Service ---------
// What external-service's `presales|legal|pm|delivery|service` modules need
// (6 Oct 2026). Every service here is the one the screen route delegates to.
// Those that live in an `-http` module (they keep files) are declared again
// as providers there beside their own `StorageModule` — never the `-http`
// module itself, whose controllers would answer on the external port.
export { PresalesModule } from './presales/presales.module';
export { SolutionsService } from './presales/solutions.service';
export { ProposalService } from './presales/proposal.service';
export { SolutionQuotationService } from './presales/solution-quotation.service';
export { HrModule } from './hr/hr.module';
export { PricingModule } from './pricing/pricing.module';
export { LegalContractsService } from './crm/legal-contracts.service';
export { ContractTermsService } from './crm/contract-terms.service';
export { ContractInstallmentsService } from './crm/contract-installments.service';
export { ContractObligationsService } from './crm/contract-obligations.service';
export {
  ContractAccessRepository,
  ContractDocumentRepository,
  CustomerContractRepository,
} from './crm/contract.repositories';
export { ListContractsQueryDto } from './crm/dto/legal-contract.dto';
export { PmModule } from './pm/pm.module';
export { ProjectsService } from './pm/projects.service';
export { MilestonesService } from './pm/milestones.service';
export { ListProjectsQueryDto, OpenProjectDto } from './pm/dto/project.dto';
export { DeliveryModule } from './delivery/delivery.module';
export { DeliveriesService } from './delivery/deliveries.service';
export { InstallmentBillingService } from './delivery/installment-billing.service';
export { ServiceHandoversService } from './delivery/service-handovers.service';
export { SupportModule } from './support/support.module';
export { ServiceAssetsService } from './support/service-assets.service';
export { EntitlementsService } from './support/entitlements.service';
export { WorkOrdersService } from './support/work-orders.service';
export {
  ListAssetsQueryDto,
  ListEntitlementsQueryDto,
  ListWorkOrdersQueryDto,
  OpenWorkOrderDto,
} from './support/support.dto';

// ERP config parsing — external-service builds the same `erp.b1` block.
export { parseCompanyDbs } from './erp/sap-b1.config';
