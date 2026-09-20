-- The P.O. is the money (Kyle, 2026-09-19): "There are too many points of
-- failure right now and adding more will only confuse the system and users."
--
-- THE CHARGE IS THE MONEY. THE RECEIPT IS PROOF, NEVER MONEY. After this
-- migration money reaches the P&L from a card charge (CardSpend) or an amount
-- typed on a P.O. marked not-on-card (plus company bills and Stripe fees).
-- Receipt.amount feeds nothing. Job material cost = the P.O.s tagged to the job.
--
-- Order matters: history is moved onto P.O.s FIRST, then the retired columns
-- are dropped. Every write here leaves a PurchaseOrderEvent (kind "migrated").

-- 1. Typed not-on-card money lives on the P.O.
ALTER TABLE "PurchaseOrder"
  ADD COLUMN "offCardAmount" DOUBLE PRECISION,
  ADD COLUMN "offCardMethod" TEXT,
  ADD COLUMN "offCardNote"   TEXT,
  ADD COLUMN "offCardAt"     TIMESTAMP(3);

-- 2. HISTORY MUST NOT GO TO ZERO. Until today a job's material could come from
--    the "receipt rung": confirmed materials receipts on the job that sit on no
--    P.O., or on a CANCELLED P.O. (Daughdrill $381.90, Womack $406.74). Each such
--    receipt becomes money on a P.O. tagged to its job:
--      A. the receipt was matched to a card charge that already rides a P.O.
--         → that P.O. is tagged to the job (the charge IS the money; nothing is
--           typed, so the P&L counts it once exactly as before);
--      B. matched to a charge with no P.O. → a closed legacy P.O. is created,
--         tagged to the job, and the charge and receipt move onto it;
--      C. no card charge at all → a closed legacy P.O. is created carrying the
--         receipt's amount as a typed not-on-card amount, dated the receipt.
DO $$
DECLARE
  r          RECORD;
  spend      RECORD;
  default_truck TEXT;
  po_id      TEXT;
  po_number  TEXT;
  po_year    INT;
  seq        INT;
  truck_id   TEXT;
  opened_at  TIMESTAMP(3);
  supplier   TEXT;
  n_a INT := 0; n_b INT := 0; n_c INT := 0;
BEGIN
  SELECT id INTO default_truck FROM "Truck" WHERE "isActive" ORDER BY "createdAt" ASC LIMIT 1;

  FOR r IN
    SELECT rc.id, rc."jobId", rc.amount, rc.vendor, rc."receivedAt", rc."purchaseOrderId",
           po.status AS po_status, po.number AS po_number
    FROM "Receipt" rc
    LEFT JOIN "PurchaseOrder" po ON po.id = rc."purchaseOrderId"
    WHERE rc.status = 'confirmed' AND rc.category = 'materials'
      AND (rc."purchaseOrderId" IS NULL OR po.status = 'cancelled')
    ORDER BY rc."receivedAt" ASC, rc."createdAt" ASC
  LOOP
    SELECT cs.id, cs."purchaseOrderId", cs."truckId", cs."merchantName", cs."occurredAt", cs.amount
      INTO spend FROM "CardSpend" cs WHERE cs."receiptId" = r.id LIMIT 1;

    IF spend.id IS NOT NULL AND spend."purchaseOrderId" IS NOT NULL THEN
      -- Case A: the charge is the money and it already has a P.O. Tag that P.O.
      -- to the receipt's job when it names none, and make sure the receipt sits
      -- on it as proof.
      n_a := n_a + 1;
      IF r."jobId" IS NOT NULL THEN
        UPDATE "PurchaseOrder" SET "jobId" = r."jobId"
          WHERE id = spend."purchaseOrderId" AND "jobId" IS NULL;
      END IF;
      IF r."purchaseOrderId" IS DISTINCT FROM spend."purchaseOrderId" THEN
        UPDATE "Receipt" SET "purchaseOrderId" = spend."purchaseOrderId" WHERE id = r.id;
      END IF;
      INSERT INTO "PurchaseOrderEvent" (id, "purchaseOrderId", actor, kind, reason, after)
      VALUES (
        'mig' || substr(md5(random()::text || clock_timestamp()::text || r.id), 1, 22),
        spend."purchaseOrderId", 'system:migration-2026-09-19', 'migrated',
        'The charge is the money: this P.O. now names the job its receipt was on, so the job keeps its material figure',
        json_build_object('receiptId', r.id, 'cardSpendId', spend.id, 'jobId', r."jobId", 'amount', spend.amount)::text
      );
    ELSE
      -- Cases B and C: a legacy P.O. of its own, closed, tagged to the job.
      truck_id := COALESCE(spend."truckId", default_truck);
      opened_at := COALESCE(spend."occurredAt", r."receivedAt");
      supplier := COALESCE(NULLIF(btrim(r.vendor), ''), spend."merchantName", 'Unknown supplier');
      po_year := EXTRACT(YEAR FROM (opened_at AT TIME ZONE 'America/Chicago'))::int;
      INSERT INTO "PurchaseOrderCounter" ("year", "next") VALUES (po_year, 2)
        ON CONFLICT ("year") DO UPDATE SET "next" = "PurchaseOrderCounter"."next" + 1
        RETURNING "next" INTO seq;
      po_number := 'PO-' || po_year || '-' || lpad((seq - 1)::text, 4, '0');
      po_id := 'mig' || substr(md5(random()::text || clock_timestamp()::text || r.id), 1, 22);

      INSERT INTO "PurchaseOrder" (
        id, number, purpose, "destinationType", "truckId", "jobId", supplier, status, notes,
        "openedBy", "afterTheFact", "openedAt", "purchasedAt", "verifiedAt", "closedAt",
        "offCardAmount", "offCardMethod", "offCardNote", "offCardAt"
      ) VALUES (
        po_id, po_number, 'truck_stock', CASE WHEN truck_id IS NULL THEN 'warehouse' ELSE 'truck' END,
        truck_id, r."jobId", supplier, 'closed',
        'Legacy P.O. created by the 2026-09-19 money migration for receipt ' || r.id
          || CASE WHEN r.po_number IS NOT NULL THEN ' (was on cancelled ' || r.po_number || ')' ELSE '' END,
        'system', true, opened_at, opened_at, now(), now(),
        CASE WHEN spend.id IS NULL THEN r.amount ELSE NULL END,
        CASE WHEN spend.id IS NULL THEN 'unknown' ELSE NULL END,
        CASE WHEN spend.id IS NULL THEN 'Typed from the receipt by the 2026-09-19 money migration — no card charge was ever matched to it' ELSE NULL END,
        CASE WHEN spend.id IS NULL THEN r."receivedAt" ELSE NULL END
      );

      IF spend.id IS NOT NULL THEN
        n_b := n_b + 1;
        UPDATE "CardSpend" SET "purchaseOrderId" = po_id WHERE id = spend.id;
      ELSE
        n_c := n_c + 1;
      END IF;

      IF r."purchaseOrderId" IS NOT NULL THEN
        INSERT INTO "PurchaseOrderEvent" (id, "purchaseOrderId", actor, kind, reason, before)
        VALUES (
          'mig' || substr(md5(random()::text || clock_timestamp()::text || r.id || 'd'), 1, 22),
          r."purchaseOrderId", 'system:migration-2026-09-19', 'receipt_detached',
          'Moved to legacy ' || po_number || ' by the 2026-09-19 money migration',
          json_build_object('receiptId', r.id, 'amount', r.amount)::text
        );
      END IF;
      UPDATE "Receipt" SET "purchaseOrderId" = po_id WHERE id = r.id;

      INSERT INTO "PurchaseOrderEvent" (id, "purchaseOrderId", actor, kind, reason, after)
      VALUES (
        'mig' || substr(md5(random()::text || clock_timestamp()::text || r.id || 'c'), 1, 22),
        po_id, 'system:migration-2026-09-19', 'migrated',
        CASE WHEN spend.id IS NULL
          THEN 'Legacy receipt with no card charge: its amount is typed here as not-on-card money so the job and the P&L keep the figure'
          ELSE 'Legacy receipt whose card charge had no P.O.: the charge now rides this P.O. and is the money'
        END,
        json_build_object('receiptId', r.id, 'cardSpendId', spend.id, 'jobId', r."jobId", 'amount', r.amount,
                          'offCardAmount', CASE WHEN spend.id IS NULL THEN r.amount ELSE NULL END)::text
      );
    END IF;
  END LOOP;

  RAISE NOTICE 'the-po-is-the-money: % receipt(s) tagged their charge''s P.O. to the job, % legacy P.O.(s) took a charge, % legacy P.O.(s) carry a typed amount', n_a, n_b, n_c;
END $$;

-- 3. "matched" (paired with a receipt) is no longer a state; the row is simply live.
UPDATE "CardSpend" SET status = 'unmatched' WHERE status = 'matched';

-- 4. A charge belongs to a P.O., not to a receipt.
ALTER TABLE "CardSpend" DROP CONSTRAINT "CardSpend_receiptId_fkey";
DROP INDEX "CardSpend_receiptId_key";
ALTER TABLE "CardSpend" DROP COLUMN "receiptId";

-- 5. The receipt rung's stored figure. Everything it held is on a P.O. now (step 2).
ALTER TABLE "Visit" DROP COLUMN "actualMaterialCost";
