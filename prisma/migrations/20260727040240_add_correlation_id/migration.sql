-- AlterTable
ALTER TABLE "public"."deliveries" ADD COLUMN     "correlationId" TEXT;

-- AlterTable
ALTER TABLE "public"."events" ADD COLUMN     "correlationId" TEXT;
