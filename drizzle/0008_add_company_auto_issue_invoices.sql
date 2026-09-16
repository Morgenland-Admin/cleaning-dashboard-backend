-- Per-brand switch for the automatic invoice on a paid order.
--
-- The auto path issues + emails immediately when the §14 fields are complete,
-- which leaves no window to extend the invoice (a repair service agreed after
-- the online booking, say) before it becomes a legal document. Turning this off
-- for a brand keeps that invoice a draft until someone finalises it by hand.
--
-- Defaults TRUE so existing brands keep behaving exactly as they do today.
ALTER TABLE "company" ADD COLUMN "auto_issue_invoices" boolean DEFAULT true NOT NULL;
