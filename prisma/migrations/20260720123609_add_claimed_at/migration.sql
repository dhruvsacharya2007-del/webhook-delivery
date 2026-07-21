-- AlterTable
ALTER TABLE "public"."deliveries" ADD COLUMN     "claimedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "deliveries_status_claimedAt_idx" ON "public"."deliveries"("status", "claimedAt");
