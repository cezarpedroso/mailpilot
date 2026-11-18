# n8n workflows

- `workflows/01-email-intake.phase1.json` is the original, working Phase 1 workflow.
- `workflows/01-email-intake.json` is the Phase 2 intake draft. It keeps the validation branch and calls the AI sub-workflow for valid input.
- `workflows/02-ai-processing.json` is the separate AI processing workflow. It classifies with OpenRouter, validates the JSON, routes via a Switch, requests a draft, and returns a structured result.
- `sample-email.json` is a request fixture. `tests/phase2-fixtures.test.cjs` checks classification validation, routing, draft validation, and failure handling without an API key.

Configure a dedicated n8n Header Auth credential with `Authorization: Bearer <OpenRouter key>` on both HTTP Request nodes. Import the AI workflow first, then select it in the intake workflow's **Run AI Processing** node. The checked-in intake JSON contains the AI workflow ID from this local n8n instance; another instance may assign a different ID.

Phase 3 adds **Has API Email ID?**, **Save Classification to Go**, and **Save Draft to Go** to the intake. Direct webhook requests without `email_id` still return the Phase 2 response. The Phase 2 intake is backed up as `workflows/01-email-intake.phase2.json`. See the repository README for the Go API and database setup.

The intake endpoint is local and unauthenticated. Phase 2 does not deduplicate, persist application emails, or send any reply.
