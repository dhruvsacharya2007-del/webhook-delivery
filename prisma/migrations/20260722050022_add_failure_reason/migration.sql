-- CreateEnum
CREATE TYPE "public"."FailureReason" AS ENUM ('RETRIES_EXHAUSTED', 'ENDPOINT_REJECTED');

-- AlterTable
ALTER TABLE "public"."deliveries" ADD COLUMN     "failureReason" "public"."FailureReason";
