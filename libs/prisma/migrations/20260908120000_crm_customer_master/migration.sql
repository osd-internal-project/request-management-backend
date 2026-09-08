-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('corporate', 'individual', 'government');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('draft', 'active', 'suspended', 'inactive');

-- CreateEnum
CREATE TYPE "CustomerContactRole" AS ENUM ('decision_maker', 'user', 'procurement', 'finance', 'other');

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "normalizedName" TEXT NOT NULL,
    "taxId" TEXT,
    "branchCode" TEXT NOT NULL DEFAULT '00000',
    "branchName" TEXT,
    "headOfficeId" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'draft',
    "kycVerified" BOOLEAN NOT NULL DEFAULT false,
    "kycVerifiedAt" TIMESTAMP(3),
    "accountOwnerUserId" TEXT,
    "ownerOrgUnitId" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "deactivateReason" TEXT,
    "suspendReason" TEXT,
    "mergedIntoCustomerId" TEXT,
    "mergedAt" TIMESTAMP(3),
    "dedupOverrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_locations" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "subDistrict" TEXT,
    "district" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'TH',
    "isBilling" BOOLEAN NOT NULL DEFAULT false,
    "isSite" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "customer_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "CustomerContactRole" NOT NULL DEFAULT 'other',
    "position" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "lineId" TEXT,
    "note" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_external_codes" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "externalCode" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "customer_external_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_field_changes" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_field_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_segment_dimensions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "customer_segment_dimensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_segment_values" (
    "id" TEXT NOT NULL,
    "dimensionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "customer_segment_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_segment_assignments" (
    "customerId" TEXT NOT NULL,
    "valueId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT,

    CONSTRAINT "customer_segment_assignments_pkey" PRIMARY KEY ("customerId","valueId")
);

-- CreateTable
CREATE TABLE "customer_code_counters" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_code_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_company_configs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL DEFAULT 'CUS',
    "codePadding" INTEGER NOT NULL DEFAULT 6,
    "dedupThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "crm_company_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_timeline_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT,
    "eventType" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "requiredPermission" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_customerCode_key" ON "customers"("customerCode");

-- CreateIndex
CREATE INDEX "customers_companyId_status_idx" ON "customers"("companyId", "status");

-- CreateIndex
CREATE INDEX "customers_companyId_accountOwnerUserId_idx" ON "customers"("companyId", "accountOwnerUserId");

-- CreateIndex
CREATE INDEX "customers_companyId_ownerOrgUnitId_idx" ON "customers"("companyId", "ownerOrgUnitId");

-- CreateIndex
CREATE INDEX "customers_companyId_normalizedName_idx" ON "customers"("companyId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "customers_companyId_taxId_branchCode_key" ON "customers"("companyId", "taxId", "branchCode");

-- CreateIndex
CREATE INDEX "customers_companyId_headOfficeId_idx" ON "customers"("companyId", "headOfficeId");

-- CreateIndex
CREATE INDEX "customer_locations_customerId_idx" ON "customer_locations"("customerId");

-- CreateIndex
CREATE INDEX "customer_contacts_customerId_idx" ON "customer_contacts"("customerId");

-- CreateIndex
CREATE INDEX "customer_external_codes_system_externalCode_idx" ON "customer_external_codes"("system", "externalCode");

-- CreateIndex
CREATE UNIQUE INDEX "customer_external_codes_customerId_system_key" ON "customer_external_codes"("customerId", "system");

-- CreateIndex
CREATE INDEX "customer_field_changes_customerId_changedAt_idx" ON "customer_field_changes"("customerId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_segment_dimensions_companyId_code_key" ON "customer_segment_dimensions"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "customer_segment_values_dimensionId_code_key" ON "customer_segment_values"("dimensionId", "code");

-- CreateIndex
CREATE INDEX "customer_segment_assignments_valueId_idx" ON "customer_segment_assignments"("valueId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_code_counters_companyId_key" ON "customer_code_counters"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "crm_company_configs_companyId_key" ON "crm_company_configs"("companyId");

-- CreateIndex
CREATE INDEX "customer_timeline_events_customerId_occurredAt_idx" ON "customer_timeline_events"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "customer_timeline_events_companyId_occurredAt_idx" ON "customer_timeline_events"("companyId", "occurredAt");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_accountOwnerUserId_fkey" FOREIGN KEY ("accountOwnerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_mergedIntoCustomerId_fkey" FOREIGN KEY ("mergedIntoCustomerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_headOfficeId_fkey" FOREIGN KEY ("headOfficeId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_external_codes" ADD CONSTRAINT "customer_external_codes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_field_changes" ADD CONSTRAINT "customer_field_changes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_segment_dimensions" ADD CONSTRAINT "customer_segment_dimensions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_segment_values" ADD CONSTRAINT "customer_segment_values_dimensionId_fkey" FOREIGN KEY ("dimensionId") REFERENCES "customer_segment_dimensions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_segment_assignments" ADD CONSTRAINT "customer_segment_assignments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_segment_assignments" ADD CONSTRAINT "customer_segment_assignments_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "customer_segment_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_code_counters" ADD CONSTRAINT "customer_code_counters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_company_configs" ADD CONSTRAINT "crm_company_configs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_timeline_events" ADD CONSTRAINT "customer_timeline_events_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

