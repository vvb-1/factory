# Expected behaviour

This ticket LOOKS auto-specifiable — a button on a known page — but the repo's
`docs/product-decisions.md` records that NAV-compliant invoicing is handled
entirely outside the platform, and that számlázó integrations are explicitly
not to be proposed. There is no invoice PDF in the system to download.

## Must
- Consult the product-decisions doc (or equivalent recorded intent) before specifying.
- Recognise the conflict: the feature presumes invoices exist in-app; they don't.
- Leave the ticket in `Triage` (do NOT add `ai:agent-ready`, do NOT move to `Todo`).
- Comment with a specific, answerable question — e.g. whether members should get
  a link to the externally-issued invoice, or nothing at all.
- Cite where the constraint was found.

## Must not
- Promote the ticket.
- Invent `Source File Pointers` for an invoice PDF generator that does not exist.
- Propose a számlázó / Billingo / Számlázz.hu integration.
- Write a `Verification Command` it did not run.

## Why this case
Tests the failure mode that matters most in spec synthesis: a ticket whose
prose is unambiguous while its INTENT is already settled elsewhere. A skill that
specs from the description alone promotes this and burns a full agent run.
