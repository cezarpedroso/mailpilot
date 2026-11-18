package main

import (
	"database/sql"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var uuidShape = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var safeCodeShape = regexp.MustCompile(`[^a-z0-9_\-]`)

func (s *server) deadline(priority string, created time.Time) time.Time {
	seconds := s.slaSeconds[priority]
	if seconds < 1 {
		seconds = s.slaSeconds["medium"]
	}
	if seconds < 1 {
		seconds = 3600
	}
	return created.Add(time.Duration(seconds) * time.Second)
}

func (s *server) listUnresolved(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT e.id,e.subject,e.priority,e.processing_status,e.created_at,d.approval_status
		FROM emails e LEFT JOIN drafts d ON d.email_id=e.id
		WHERE (d.approval_status IS NULL OR d.approval_status='pending')
		AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.email_id=e.id AND n.type='sla_escalation')
		ORDER BY e.created_at LIMIT 200`)
	if err != nil {
		s.log.Error("list unresolved", "error", err)
		fail(w, 500, "database_error")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, subject, status string
		var priority, approval sql.NullString
		var created time.Time
		if rows.Scan(&id, &subject, &priority, &status, &created, &approval) != nil {
			fail(w, 500, "database_error")
			return
		}
		p := "medium"
		if priority.Valid {
			p = priority.String
		}
		out = append(out, map[string]any{"id": id, "subject": subject, "priority": p, "processing_status": status, "created_at": created, "deadline_at": s.deadline(p, created), "approval_status": approval.String})
	}
	if rows.Err() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, out)
}

func (s *server) escalateEmail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidShape.MatchString(id) {
		fail(w, 400, "invalid_id")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.log.Error("escalation begin", "error", err)
		fail(w, 500, "database_error")
		return
	}
	defer tx.Rollback()
	var priority sql.NullString
	var created time.Time
	err = tx.QueryRowContext(r.Context(), `SELECT priority,created_at FROM emails WHERE id=$1 FOR UPDATE`, id).Scan(&priority, &created)
	if err == sql.ErrNoRows {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		s.log.Error("escalation load email", "error", err)
		fail(w, 500, "database_error")
		return
	}
	var approval sql.NullString
	err = tx.QueryRowContext(r.Context(), `SELECT approval_status FROM drafts WHERE email_id=$1`, id).Scan(&approval)
	if err != nil && err != sql.ErrNoRows {
		s.log.Error("escalation load draft", "error", err)
		fail(w, 500, "database_error")
		return
	}
	if approval.Valid && approval.String != "pending" {
		writeJSON(w, 200, map[string]any{"created": false, "reason": "resolved"})
		return
	}
	p := "medium"
	if priority.Valid {
		p = priority.String
	}
	if time.Now().Before(s.deadline(p, created)) {
		fail(w, 409, "sla_not_due")
		return
	}
	key := id + ":sla_overdue"
	var notificationID string
	err = tx.QueryRowContext(r.Context(), `INSERT INTO notifications(email_id,type,message,idempotency_key)
		VALUES($1,'sla_escalation','Response deadline exceeded; review this email.',$2)
		ON CONFLICT DO NOTHING RETURNING id`, id, key).Scan(&notificationID)
	createdNotification := err == nil
	if err != nil && err != sql.ErrNoRows {
		s.log.Error("escalation notification", "error", err)
		fail(w, 500, "database_error")
		return
	}
	if createdNotification {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO workflow_events(email_id,event_type,idempotency_key,details)
			VALUES($1,'sla_escalated',$2,jsonb_build_object('priority',$3::text,'deadline_at',$4::timestamptz))
			ON CONFLICT(idempotency_key) DO NOTHING`, id, key, p, s.deadline(p, created))
		if err != nil {
			s.log.Error("escalation event", "error", err)
			fail(w, 500, "database_error")
			return
		}
	}
	if err = tx.Commit(); err != nil {
		s.log.Error("escalation commit", "error", err)
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]any{"created": createdNotification, "notification_id": notificationID})
}

func (s *server) listRetryCandidates(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT id,processing_status,retry_attempts,next_retry_at
		FROM emails WHERE processing_status IN ('queued','ai_failed','draft_failed')
		AND retry_attempts<$1 AND next_retry_at<=now()
		AND (retry_lease_until IS NULL OR retry_lease_until<=now())
		ORDER BY next_retry_at,id LIMIT 100`, s.maxRetries)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, status string
		var attempts int
		var next time.Time
		if rows.Scan(&id, &status, &attempts, &next) != nil {
			fail(w, 500, "database_error")
			return
		}
		out = append(out, map[string]any{"id": id, "processing_status": status, "retry_attempts": attempts, "next_retry_at": next})
	}
	if rows.Err() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, out)
}

func (s *server) claimRetry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidShape.MatchString(id) {
		fail(w, 400, "invalid_id")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer tx.Rollback()
	var external, sender, subject, body, token string
	var attempts int
	err = tx.QueryRowContext(r.Context(), `UPDATE emails SET retry_attempts=retry_attempts+1,
		retry_claim_token=gen_random_uuid(),retry_lease_until=now()+($2::integer*interval '1 second'),updated_at=now()
		WHERE id=$1 AND processing_status IN ('queued','ai_failed','draft_failed')
		AND retry_attempts<$3 AND next_retry_at<=now()
		AND (retry_lease_until IS NULL OR retry_lease_until<=now())
		RETURNING external_message_id,sender,subject,body,retry_attempts,retry_claim_token`, id, int(s.retryLease.Seconds()), s.maxRetries).Scan(&external, &sender, &subject, &body, &attempts, &token)
	if err == sql.ErrNoRows {
		fail(w, 409, "retry_not_eligible")
		return
	}
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO workflow_events(email_id,event_type,idempotency_key,details)
		VALUES($1,'recovery_claimed',$2,jsonb_build_object('attempt',$3::integer)) ON CONFLICT(idempotency_key) DO NOTHING`, id, id+":recovery_claimed:"+itoa(attempts), attempts)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	if tx.Commit() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]any{"email_id": id, "external_message_id": external, "sender": sender, "subject": subject, "body": body, "retry_attempts": attempts, "claim_token": token})
}

type retryCompletion struct {
	ClaimToken string `json:"claim_token"`
	Success    bool   `json:"success"`
	ErrorCode  string `json:"error_code"`
}

func (s *server) completeRetry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !uuidShape.MatchString(id) {
		fail(w, 400, "invalid_id")
		return
	}
	var in retryCompletion
	if !decode(w, r, &in) {
		return
	}
	if !uuidShape.MatchString(in.ClaimToken) {
		fail(w, 400, "invalid_claim_token")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer tx.Rollback()
	var token sql.NullString
	var status string
	var attempts int
	err = tx.QueryRowContext(r.Context(), `SELECT retry_claim_token,processing_status,retry_attempts FROM emails WHERE id=$1 FOR UPDATE`, id).Scan(&token, &status, &attempts)
	if err == sql.ErrNoRows {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	if !token.Valid || token.String != in.ClaimToken {
		fail(w, 409, "claim_mismatch")
		return
	}
	var hasDraft bool
	if tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM drafts WHERE email_id=$1)`, id).Scan(&hasDraft) != nil {
		fail(w, 500, "database_error")
		return
	}
	completed := (status == "processed" || status == "needs_review") && hasDraft
	code := safeCode(in.ErrorCode)
	event := "recovery_succeeded"
	if completed {
		_, err = tx.ExecContext(r.Context(), `UPDATE emails SET retry_claim_token=NULL,retry_lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE id=$1`, id)
	} else {
		if code == "unspecified" {
			code = "pipeline_incomplete"
		}
		backoff := retryBackoff(s.retryBase, attempts)
		newStatus := "queued"
		if attempts >= s.maxRetries {
			newStatus = "retry_exhausted"
			event = "recovery_exhausted"
		} else {
			event = "recovery_failed"
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE emails SET processing_status=$2,next_retry_at=now()+($3::integer*interval '1 second'),retry_claim_token=NULL,retry_lease_until=NULL,last_error_code=$4,updated_at=now() WHERE id=$1`, id, newStatus, int(backoff.Seconds()), code)
		if err == nil && newStatus == "retry_exhausted" {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO notifications(email_id,type,message,idempotency_key)
				VALUES($1,'retry_exhausted','Automatic recovery exhausted; manual review required.',$2)
				ON CONFLICT DO NOTHING`, id, id+":retry_exhausted")
		}
	}
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	_, err = tx.ExecContext(r.Context(), `INSERT INTO workflow_events(email_id,event_type,idempotency_key,details)
		VALUES($1,$2,$3,jsonb_build_object('attempt',$4::integer,'error_code',$5::text)) ON CONFLICT(idempotency_key) DO NOTHING`, id, event, id+":"+event+":"+itoa(attempts), attempts, code)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	if tx.Commit() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]any{"recovered": completed, "attempt": attempts, "status": event})
}

func retryBackoff(base time.Duration, attempt int) time.Duration {
	if base <= 0 {
		base = 30 * time.Second
	}
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 7 {
		attempt = 7
	}
	return base * time.Duration(1<<(attempt-1))
}
func itoa(n int) string { return strconv.Itoa(n) }
func safeCode(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	if len(v) > 64 {
		v = v[:64]
	}
	v = safeCodeShape.ReplaceAllString(v, "_")
	if v == "" {
		return "unspecified"
	}
	return v
}

type failureInput struct {
	WorkflowID     string `json:"workflow_id"`
	WorkflowName   string `json:"workflow_name"`
	ExecutionID    string `json:"execution_id"`
	ErrorCode      string `json:"error_code"`
	ErrorMessage   string `json:"error_message"`
	IdempotencyKey string `json:"idempotency_key"`
}

func (s *server) recordAutomationFailure(w http.ResponseWriter, r *http.Request) {
	var in failureInput
	if !decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.WorkflowID) == "" || strings.TrimSpace(in.IdempotencyKey) == "" || len(in.IdempotencyKey) > 255 {
		fail(w, 400, "invalid_failure")
		return
	}
	name := safeLabel(in.WorkflowName, 100)
	message := safeLabel(in.ErrorMessage, 240)
	code := safeCode(in.ErrorCode)
	if name == "" {
		name = "Unknown workflow"
	}
	if message == "" {
		message = "Workflow execution failed"
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer tx.Rollback()
	var failureID string
	err = tx.QueryRowContext(r.Context(), `INSERT INTO automation_failures(workflow_id,workflow_name,execution_id,error_code,error_message,idempotency_key)
		VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, safeLabel(in.WorkflowID, 100), name, safeLabel(in.ExecutionID, 100), code, message, in.IdempotencyKey).Scan(&failureID)
	created := err == nil
	if err != nil && err != sql.ErrNoRows {
		fail(w, 500, "database_error")
		return
	}
	if created {
		_, err = tx.ExecContext(r.Context(), `INSERT INTO notifications(type,message,idempotency_key)
			VALUES('automation_error',$1,$2) ON CONFLICT DO NOTHING`, "Unexpected failure in "+name, in.IdempotencyKey)
		if err != nil {
			fail(w, 500, "database_error")
			return
		}
	}
	if tx.Commit() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]any{"created": created, "id": failureID})
}

var emailShape = regexp.MustCompile(`(?i)[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}`)
var secretShape = regexp.MustCompile(`(?i)(bearer\s+|sk-[A-Za-z0-9_\-]{8,}|api[_-]?key\s*[:=]\s*)\S+`)

func safeLabel(v string, max int) string {
	v = strings.Join(strings.Fields(v), " ")
	v = emailShape.ReplaceAllString(v, "[email]")
	v = secretShape.ReplaceAllString(v, "[redacted]")
	if len(v) > max {
		v = v[:max]
	}
	return v
}

func (s *server) listAutomationErrors(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT id,workflow_id,workflow_name,execution_id,error_code,error_message,created_at FROM automation_failures ORDER BY created_at DESC,id DESC LIMIT 100`)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, wid, name, code, message string
		var exec sql.NullString
		var created time.Time
		if rows.Scan(&id, &wid, &name, &exec, &code, &message, &created) != nil {
			fail(w, 500, "database_error")
			return
		}
		out = append(out, map[string]any{"id": id, "workflow_id": wid, "workflow_name": name, "execution_id": exec.String, "error_code": code, "error_message": message, "created_at": created})
	}
	if rows.Err() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, out)
}
func (s *server) listNotifications(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `SELECT n.id,n.email_id,n.type,n.message,n.read_at,n.created_at,e.subject FROM notifications n LEFT JOIN emails e ON e.id=n.email_id ORDER BY n.created_at DESC,n.id DESC LIMIT 100`)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, kind, message string
		var emailID, subject sql.NullString
		var readAt sql.NullTime
		var created time.Time
		if rows.Scan(&id, &emailID, &kind, &message, &readAt, &created, &subject) != nil {
			fail(w, 500, "database_error")
			return
		}
		var read any
		if readAt.Valid {
			read = readAt.Time
		}
		out = append(out, map[string]any{"id": id, "email_id": emailID.String, "type": kind, "message": message, "read_at": read, "created_at": created, "subject": subject.String})
	}
	if rows.Err() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, out)
}
