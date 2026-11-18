package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type reviewInput struct {
	Content        *string `json:"content"`
	ApprovalStatus *string `json:"approval_status"`
}

func (s *server) reviewDraft(w http.ResponseWriter, r *http.Request) {
	var in reviewInput
	if !decode(w, r, &in) {
		return
	}
	if in.Content == nil && in.ApprovalStatus == nil {
		fail(w, 400, "empty_update")
		return
	}
	if in.Content != nil {
		v := strings.TrimSpace(*in.Content)
		if v == "" {
			fail(w, 400, "invalid_draft")
			return
		}
		in.Content = &v
	}
	if in.ApprovalStatus != nil && !contains([]string{"approved", "rejected"}, *in.ApprovalStatus) {
		fail(w, 400, "invalid_approval_status")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer tx.Rollback()
	var d draft
	err = tx.QueryRowContext(r.Context(), "UPDATE drafts SET content=COALESCE($2,content),approval_status=COALESCE($3,approval_status),updated_at=now() WHERE email_id=$1 AND approval_status='pending' RETURNING id,email_id,content,approval_status,created_at,updated_at", r.PathValue("id"), in.Content, in.ApprovalStatus).Scan(&d.ID, &d.EmailID, &d.Content, &d.ApprovalStatus, &d.CreatedAt, &d.UpdatedAt)
	if err == sql.ErrNoRows {
		var exists bool
		_ = tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM drafts WHERE email_id=$1)", r.PathValue("id")).Scan(&exists)
		if exists {
			fail(w, 409, "draft_already_reviewed")
		} else {
			fail(w, 404, "draft_not_found")
		}
		return
	}
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	kind := "draft_updated"
	if in.ApprovalStatus != nil {
		kind = "draft_" + *in.ApprovalStatus
	}
	sum := sha256.Sum256([]byte(kind + ":" + d.Content))
	key := d.ID + ":" + hex.EncodeToString(sum[:])
	if _, err = tx.ExecContext(r.Context(), "INSERT INTO workflow_events(email_id,event_type,idempotency_key) VALUES($1,$2,$3) ON CONFLICT(idempotency_key) DO NOTHING", d.EmailID, kind, key); err != nil {
		fail(w, 500, "database_error")
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, d)
}

func (s *server) analytics(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"by_category": map[string]int64{}, "by_priority": map[string]int64{}}
	var total, processed, pending, awaiting int64
	err := s.db.QueryRowContext(r.Context(), `SELECT count(*),count(*) FILTER (WHERE processing_status='processed'),count(*) FILTER (WHERE processing_status='queued'),(SELECT count(*) FROM drafts WHERE approval_status='pending') FROM emails`).Scan(&total, &processed, &pending, &awaiting)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	out["total_emails"], out["processed_emails"], out["pending_emails"], out["drafts_awaiting_approval"] = total, processed, pending, awaiting
	for _, kind := range []string{"category", "priority"} {
		rows, e := s.db.QueryContext(r.Context(), "SELECT "+kind+",count(*) FROM emails WHERE "+kind+" IS NOT NULL GROUP BY "+kind)
		if e != nil {
			fail(w, 500, "database_error")
			return
		}
		counts := map[string]int64{}
		for rows.Next() {
			var label string
			var count int64
			if rows.Scan(&label, &count) != nil {
				rows.Close()
				fail(w, 500, "database_error")
				return
			}
			counts[label] = count
		}
		rows.Close()
		out["by_"+kind] = counts
	}
	writeJSON(w, 200, out)
}

func (s *server) listWorkflowEvents(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT v.id,v.email_id,v.event_type,v.details,v.created_at,e.subject,e.external_message_id FROM workflow_events v JOIN emails e ON e.id=v.email_id ORDER BY v.created_at DESC,v.id DESC LIMIT 100`)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, emailID, kind, subject, externalID string
		var details json.RawMessage
		var at time.Time
		if rows.Scan(&id, &emailID, &kind, &details, &at, &subject, &externalID) != nil {
			fail(w, 500, "database_error")
			return
		}
		out = append(out, map[string]any{"id": id, "email_id": emailID, "event_type": kind, "details": details, "created_at": at, "subject": subject, "external_message_id": externalID})
	}
	writeJSON(w, 200, out)
}
