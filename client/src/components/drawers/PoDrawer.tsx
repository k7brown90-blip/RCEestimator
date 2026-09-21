/**
 * The P.O. drawer (2026-09-20): `PoDetailPanel` — lines, money, receipts, landing, status
 * transitions, the trail — re-hosted over whatever list the P.O. was clicked on. The panel
 * was already the P.O. drawer in everything but hosting; nothing in it is rewritten here.
 */

import { Link } from "react-router-dom";
import { useDrawerParams } from "../../lib/drawers";
import { Drawer } from "../Drawer";
import { PO_PURPOSE_LABEL, PoDetailPanel, PoStatusPill, usePurchaseOrderDetail, useReceiptsNeedingPo } from "../PurchaseOrders";
import { OpenDrawerButton } from "./OpenDrawerButton";

export function PoDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: po, isLoading, error } = usePurchaseOrderDetail(id);
  const { data: needing = [] } = useReceiptsNeedingPo();
  const drawers = useDrawerParams();

  return (
    <Drawer
      title={po ? po.number : "Purchase order"}
      subtitle={po ? `${po.supplier} · ${PO_PURPOSE_LABEL[po.purpose] ?? po.purpose} · ${po.destinationType === "warehouse" ? "Warehouse" : po.truckName ?? "truck"}` : undefined}
      onClose={onClose}
      headerActions={po ? <PoStatusPill status={po.status} /> : null}
    >
      {error && <p className="text-sm text-red-600">Could not load this P.O.: {(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-rce-muted">Loading…</p>}
      {po && (po.jobId || po.accountId) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-rce-muted">
          {po.jobId && (
            <OpenDrawerButton kind="job" id={po.jobId} onOpen={drawers.open} label={`Job: ${po.jobLabel ?? "open"}`} />
          )}
          {po.accountId && (
            <Link to={`/accounts/${po.accountId}`} className="btn btn-secondary px-2 py-0.5 text-xs min-h-0">
              {po.accountName ?? "Account"} →
            </Link>
          )}
        </div>
      )}
      {po && <PoDetailPanel id={id} needing={needing} />}
    </Drawer>
  );
}
