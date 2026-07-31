-- AlterTable
ALTER TABLE "public"."deliveries" ADD COLUMN     "endpointSeq" INTEGER;

-- AlterTable
ALTER TABLE "public"."endpoints" ADD COLUMN     "deliverySequence" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "deliveries_status_endpointSeq_nextRetryAt_idx" ON "public"."deliveries"("status", "endpointSeq", "nextRetryAt");
