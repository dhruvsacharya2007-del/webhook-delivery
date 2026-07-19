-- CreateTable
CREATE TABLE "public"."endpoints" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "signingSecret" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."deliveries" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "status" "public"."DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."delivery_attempts" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "statusCode" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_idempotencyKey_key" ON "public"."events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "events_eventType_idx" ON "public"."events"("eventType");

-- CreateIndex
CREATE INDEX "deliveries_status_nextRetryAt_idx" ON "public"."deliveries"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_eventId_endpointId_key" ON "public"."deliveries"("eventId", "endpointId");

-- CreateIndex
CREATE INDEX "delivery_attempts_deliveryId_idx" ON "public"."delivery_attempts"("deliveryId");

-- AddForeignKey
ALTER TABLE "public"."deliveries" ADD CONSTRAINT "deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."deliveries" ADD CONSTRAINT "deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "public"."endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."delivery_attempts" ADD CONSTRAINT "delivery_attempts_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "public"."deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
