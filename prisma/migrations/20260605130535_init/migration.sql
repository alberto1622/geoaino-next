-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ErrorType" AS ENUM ('OVERLAP', 'GAP', 'SLIVER', 'DUPLICATE', 'INVALID_GEOM', 'BOUNDARY_CROSS', 'MISSING_NICAD', 'SELF_INTERSECT');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('SUMMARY', 'DETAILED', 'EXPERT', 'CORRECTION');

-- CreateEnum
CREATE TYPE "AdminLayerType" AS ENUM ('COMMUNE', 'DEPARTEMENT', 'REGION', 'SECTION', 'ILOT');

-- CreateEnum
CREATE TYPE "OpType" AS ENUM ('BUFFER', 'UNION', 'SIMPLIFY', 'ZONAL_STATS', 'AUTO_CORRECT', 'CENTROIDS', 'VALIDATE', 'EXPORT_ZIP');

-- CreateEnum
CREATE TYPE "OpStatus" AS ENUM ('SUCCESS', 'ERROR');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "password" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSignedIn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" SERIAL NOT NULL,
    "userId" TEXT,
    "fileName" TEXT NOT NULL,
    "fileFormat" TEXT NOT NULL,
    "fileSize" BIGINT,
    "status" "Status" NOT NULL DEFAULT 'PENDING',
    "totalFeatures" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "conformityScore" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "totalSurface" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "crs" TEXT,
    "commune" TEXT,
    "region" TEXT,
    "geojsonKey" TEXT,
    "geojsonUrl" TEXT,
    "summaryStats" JSONB,
    "geoJsonData" TEXT,
    "adminBoundaryData" TEXT,
    "errorsData" TEXT,
    "correctedData" TEXT,
    "aiReport" TEXT,
    "processingTime" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopologicalError" (
    "id" SERIAL NOT NULL,
    "analysisId" INTEGER NOT NULL,
    "errorType" "ErrorType" NOT NULL,
    "severity" "Severity" NOT NULL,
    "nicad1" TEXT,
    "nicad2" TEXT,
    "description" TEXT,
    "geometry" JSONB,
    "area" DECIMAL(20,4),
    "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0000,
    "corrected" BOOLEAN NOT NULL DEFAULT false,
    "correctionGeometry" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopologicalError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" SERIAL NOT NULL,
    "analysisId" INTEGER NOT NULL,
    "userId" TEXT,
    "reportType" "ReportType" NOT NULL DEFAULT 'SUMMARY',
    "title" TEXT,
    "content" TEXT,
    "pdfKey" TEXT,
    "pdfUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminLayer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "layerType" "AdminLayerType" NOT NULL,
    "geojsonKey" TEXT,
    "geojsonUrl" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminLayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverlapGeometry" (
    "id" SERIAL NOT NULL,
    "analysisId" INTEGER NOT NULL,
    "nicad1" TEXT,
    "nicad2" TEXT,
    "intersectionGeometry" JSONB NOT NULL,
    "overlapAreaM2" DECIMAL(20,4),
    "overlapPercent" DECIMAL(8,4),
    "area1M2" DECIMAL(20,4),
    "area2M2" DECIMAL(20,4),
    "severity" DECIMAL(5,4),
    "featureIndex1" INTEGER,
    "featureIndex2" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverlapGeometry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoEngineResult" (
    "id" SERIAL NOT NULL,
    "analysisId" INTEGER NOT NULL,
    "gapsData" TEXT,
    "centroidsData" TEXT,
    "zonalStatsData" JSONB,
    "globalStatsData" JSONB,
    "topologyReportData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeoEngineResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeoprocessingOp" (
    "id" SERIAL NOT NULL,
    "analysisId" INTEGER NOT NULL,
    "opType" "OpType" NOT NULL,
    "params" JSONB,
    "result" JSONB,
    "status" "OpStatus" NOT NULL DEFAULT 'SUCCESS',
    "errorMessage" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoprocessingOp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" SERIAL NOT NULL,
    "analysisId" INTEGER,
    "userId" TEXT,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopologicalError" ADD CONSTRAINT "TopologicalError_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminLayer" ADD CONSTRAINT "AdminLayer_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverlapGeometry" ADD CONSTRAINT "OverlapGeometry_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoEngineResult" ADD CONSTRAINT "GeoEngineResult_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeoprocessingOp" ADD CONSTRAINT "GeoprocessingOp_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
