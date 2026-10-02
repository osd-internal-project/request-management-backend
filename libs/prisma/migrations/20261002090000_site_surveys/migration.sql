-- CreateTable
CREATE TABLE "project_surveys" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "site" TEXT NOT NULL,
    "surveyedOn" DATE NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "summary" TEXT,
    "assumptions" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "project_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_survey_photos" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "caption" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "takenAt" TIMESTAMP(3),
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_survey_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_surveys_projectId_seq_key" ON "project_surveys"("projectId", "seq");

-- CreateIndex
CREATE INDEX "project_survey_photos_surveyId_idx" ON "project_survey_photos"("surveyId");

-- AddForeignKey
ALTER TABLE "project_surveys" ADD CONSTRAINT "project_surveys_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_survey_photos" ADD CONSTRAINT "project_survey_photos_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "project_surveys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

