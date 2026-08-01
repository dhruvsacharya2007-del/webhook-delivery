-- AlterTable
ALTER TABLE "public"."endpoints" ADD COLUMN     "breakerOpenUntil" TIMESTAMP(3),
ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0;
