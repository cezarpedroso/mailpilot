package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type server struct {
	db             *sql.DB
	n8nURL, token  string
	frontendToken  string
	client         *http.Client
	log            *slog.Logger
	slaSeconds     map[string]int
	maxRetries     int
	retryBase      time.Duration
	retryLease     time.Duration
	syncProcessing bool
	rateLimit      int
	rateMu         sync.Mutex
	rateWindows    map[string]rateWindow
}
type rateWindow struct {
	started  time.Time
	requests int
}
type email struct {
	ID                string     `json:"id"`
	ExternalMessageID string     `json:"external_message_id"`
	Sender            string     `json:"sender"`
	Subject           string     `json:"subject"`
	Body              string     `json:"body"`
	Category          *string    `json:"category"`
	Priority          *string    `json:"priority"`
	AssignedTeam      *string    `json:"assigned_team"`
	Summary           *string    `json:"summary"`
	NeedsReview       bool       `json:"needs_review"`
	ProcessingStatus  string     `json:"processing_status"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	Draft             *draft     `json:"draft,omitempty"`
	DraftStatus       *string    `json:"draft_status,omitempty"`
	RetryAttempts     int        `json:"retry_attempts"`
	NextRetryAt       time.Time  `json:"next_retry_at"`
	RetryLeaseUntil   *time.Time `json:"retry_lease_until,omitempty"`
	LastErrorCode     *string    `json:"last_error_code,omitempty"`
}
type draft struct {
	ID             string    `json:"id"`
	EmailID        string    `json:"email_id"`
	Content        string    `json:"content"`
	ApprovalStatus string    `json:"approval_status"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}
type createEmail struct {
	ExternalMessageID string `json:"external_message_id"`
	Sender            string `json:"sender"`
	Subject           string `json:"subject"`
	Body              string `json:"body"`
}
type classification struct {
	Category         string `json:"category"`
	Priority         string `json:"priority"`
	AssignedTeam     string `json:"assigned_team"`
	Summary          string `json:"summary"`
	NeedsReview      bool   `json:"needs_review"`
	ProcessingStatus string `json:"processing_status"`
}
type draftInput struct {
	Content string `json:"content"`
}
type eventInput struct {
	EmailID        string          `json:"email_id"`
	EventType      string          `json:"event_type"`
	IdempotencyKey string          `json:"idempotency_key"`
	Details        json.RawMessage `json:"details"`
}

const emailColumns = `id,external_message_id,sender,subject,body,category,priority,assigned_team,summary,needs_review,processing_status,created_at,updated_at,retry_attempts,next_retry_at,retry_lease_until,last_error_code`

func positiveEnv(name string, fallback int) int {
	v, err := strconv.Atoi(os.Getenv(name))
	if err != nil || v < 1 {
		return fallback
	}
	return v
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		r, e := http.Get("http://127.0.0.1:" + port + "/health")
		if e != nil || r.StatusCode != 200 {
			os.Exit(1)
		}
		r.Body.Close()
		return
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	dsn, token, url := os.Getenv("DATABASE_URL"), os.Getenv("MAILPILOT_INTERNAL_TOKEN"), os.Getenv("N8N_INTAKE_URL")
	if dsn == "" || token == "" || url == "" {
		logger.Error("missing required configuration")
		os.Exit(1)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		logger.Error("open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err = db.PingContext(ctx); err != nil {
		logger.Error("database unavailable", "error", err)
		os.Exit(1)
	}
	if err = applyMigrations(ctx, db); err != nil {
		logger.Error("apply reliability migration", "error", err)
		os.Exit(1)
	}
	frontendToken := os.Getenv("MAILPILOT_FRONTEND_TOKEN")
	if frontendToken == "" && os.Getenv("APP_ENV") == "production" {
		logger.Error("missing MAILPILOT_FRONTEND_TOKEN in production")
		os.Exit(1)
	}
	if frontendToken == "" {
		frontendToken = token
		logger.Warn("MAILPILOT_FRONTEND_TOKEN is unset; using the internal token for local development only")
	}
	s := &server{db: db, n8nURL: url, token: token, frontendToken: frontendToken, client: &http.Client{Timeout: 55 * time.Second}, log: logger,
		slaSeconds: map[string]int{"high": positiveEnv("SLA_HIGH_SECONDS", 900), "medium": positiveEnv("SLA_MEDIUM_SECONDS", 3600), "low": positiveEnv("SLA_LOW_SECONDS", 14400)},
		maxRetries: positiveEnv("MAX_RETRY_ATTEMPTS", 3), retryBase: time.Duration(positiveEnv("RETRY_BASE_SECONDS", 30)) * time.Second,
		retryLease:     time.Duration(positiveEnv("RETRY_LEASE_SECONDS", 90)) * time.Second,
		syncProcessing: os.Getenv("N8N_SYNC_PROCESSING") != "false", rateLimit: positiveEnv("EMAIL_SIMULATION_RATE_LIMIT", 10), rateWindows: map[string]rateWindow{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /emails", s.frontend(s.limitEmailCreation(s.createEmail)))
	mux.HandleFunc("GET /emails", s.frontend(s.listEmails))
	mux.HandleFunc("GET /emails/{id}", s.frontend(s.getEmail))
	mux.HandleFunc("GET /emails/{id}/events", s.frontend(s.getEvents))
	mux.HandleFunc("PATCH /emails/{id}/draft", s.frontend(s.reviewDraft))
	mux.HandleFunc("GET /analytics", s.frontend(s.analytics))
	mux.HandleFunc("GET /workflow-events", s.frontend(s.listWorkflowEvents))
	mux.HandleFunc("GET /notifications", s.frontend(s.listNotifications))
	mux.HandleFunc("GET /automation-errors", s.frontend(s.listAutomationErrors))
	mux.HandleFunc("GET /internal/automation/unresolved", s.auth(s.listUnresolved))
	mux.HandleFunc("POST /internal/automation/emails/{id}/escalate", s.auth(s.escalateEmail))
	mux.HandleFunc("GET /internal/automation/retry-candidates", s.auth(s.listRetryCandidates))
	mux.HandleFunc("POST /internal/automation/emails/{id}/claim", s.auth(s.claimRetry))
	mux.HandleFunc("POST /internal/automation/emails/{id}/complete", s.auth(s.completeRetry))
	mux.HandleFunc("POST /internal/automation/failures", s.auth(s.recordAutomationFailure))
	mux.HandleFunc("PATCH /internal/emails/{id}/classification", s.auth(s.patchClassification))
	mux.HandleFunc("POST /internal/emails/{id}/drafts", s.auth(s.postDraft))
	mux.HandleFunc("POST /internal/workflow-events", s.auth(s.postEvent))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		mux.ServeHTTP(w, r)
		logger.Info("http request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(start).Milliseconds())
	})
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	httpServer := &http.Server{Addr: "0.0.0.0:" + port, Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 70 * time.Second, IdleTimeout: 90 * time.Second}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer shutdownCancel()
		logger.Info("api shutting down")
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	logger.Info("api listening", "addr", httpServer.Addr)
	if err = httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func applyMigrations(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "SELECT pg_advisory_lock(hashtext('mailpilot:migrations'))"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(hashtext('mailpilot:migrations'))")
	for _, filename := range []string{"/migrations/001_init.sql", "/migrations/002_reliability.sql"} {
		migration, readErr := os.ReadFile(filename)
		if readErr != nil {
			return readErr
		}
		if _, err = conn.ExecContext(ctx, string(migration)); err != nil {
			return err
		}
	}
	return nil
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		fail(w, 400, "invalid_json")
		return false
	}
	return true
}
func trimEmail(e *createEmail) {
	e.ExternalMessageID = strings.TrimSpace(e.ExternalMessageID)
	e.Sender = strings.TrimSpace(e.Sender)
	e.Subject = strings.TrimSpace(e.Subject)
	e.Body = strings.TrimSpace(e.Body)
}
func validEmail(e createEmail) bool {
	return e.ExternalMessageID != "" && e.Sender != "" && e.Subject != "" && e.Body != "" && len(e.ExternalMessageID) <= 255 && len(e.Sender) <= 320
}
func (s *server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-MailPilot-Token")
		if len(got) != len(s.token) || subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			fail(w, 401, "unauthorized")
			return
		}
		next(w, r)
	}
}
func (s *server) frontend(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-MailPilot-Frontend-Token")
		if got == "" && os.Getenv("APP_ENV") != "production" {
			next(w, r)
			return
		}
		if len(got) != len(s.frontendToken) || subtle.ConstantTimeCompare([]byte(got), []byte(s.frontendToken)) != 1 {
			fail(w, 401, "unauthorized")
			return
		}
		next(w, r)
	}
}
func (s *server) limitEmailCreation(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimSpace(r.Header.Get("X-MailPilot-Actor"))
		if key == "" {
			key = r.RemoteAddr
		}
		now := time.Now()
		s.rateMu.Lock()
		window := s.rateWindows[key]
		if window.started.IsZero() || now.Sub(window.started) >= time.Minute {
			window = rateWindow{started: now}
		}
		window.requests++
		s.rateWindows[key] = window
		allowed := window.requests <= s.rateLimit
		s.rateMu.Unlock()
		if !allowed {
			w.Header().Set("Retry-After", "60")
			fail(w, 429, "rate_limited")
			return
		}
		next(w, r)
	}
}
func (s *server) health(w http.ResponseWriter, r *http.Request) {
	ctx, c := context.WithTimeout(r.Context(), 2*time.Second)
	defer c()
	if s.db.PingContext(ctx) != nil {
		fail(w, 503, "database_unavailable")
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}
func scanEmail(row interface{ Scan(...any) error }) (email, error) {
	var e email
	err := row.Scan(&e.ID, &e.ExternalMessageID, &e.Sender, &e.Subject, &e.Body, &e.Category, &e.Priority, &e.AssignedTeam, &e.Summary, &e.NeedsReview, &e.ProcessingStatus, &e.CreatedAt, &e.UpdatedAt, &e.RetryAttempts, &e.NextRetryAt, &e.RetryLeaseUntil, &e.LastErrorCode)
	return e, err
}
func (s *server) loadEmail(ctx context.Context, id string) (email, error) {
	e, err := scanEmail(s.db.QueryRowContext(ctx, "SELECT "+emailColumns+" FROM emails WHERE id=$1", id))
	if err != nil {
		return e, err
	}
	var d draft
	err = s.db.QueryRowContext(ctx, "SELECT id,email_id,content,approval_status,created_at,updated_at FROM drafts WHERE email_id=$1", id).Scan(&d.ID, &d.EmailID, &d.Content, &d.ApprovalStatus, &d.CreatedAt, &d.UpdatedAt)
	if err == nil {
		e.Draft = &d
	} else if err != sql.ErrNoRows {
		return e, err
	}
	return e, nil
}
func (s *server) createEmail(w http.ResponseWriter, r *http.Request) {
	var in createEmail
	if !decode(w, r, &in) {
		return
	}
	trimEmail(&in)
	if !validEmail(in) {
		fail(w, 400, "invalid_email")
		return
	}
	e, err := scanEmail(s.db.QueryRowContext(r.Context(), "INSERT INTO emails(external_message_id,sender,subject,body) VALUES($1,$2,$3,$4) ON CONFLICT(external_message_id) DO NOTHING RETURNING "+emailColumns, in.ExternalMessageID, in.Sender, in.Subject, in.Body))
	if err == sql.ErrNoRows {
		e, err = scanEmail(s.db.QueryRowContext(r.Context(), "SELECT "+emailColumns+" FROM emails WHERE external_message_id=$1", in.ExternalMessageID))
		if err == nil {
			e, err = s.loadEmail(r.Context(), e.ID)
			if err == nil && ((e.ProcessingStatus == "processed" && e.Draft != nil) || e.ProcessingStatus == "needs_review") {
				writeJSON(w, 200, e)
				return
			}
			if err == nil && e.ProcessingStatus == "retry_exhausted" {
				writeJSON(w, 200, e)
				return
			}
			if err == nil && e.RetryLeaseUntil != nil && e.RetryLeaseUntil.After(time.Now()) {
				writeJSON(w, 202, e)
				return
			}
		}
	}
	if err != nil {
		s.log.Error("insert email", "error", err)
		fail(w, 500, "database_error")
		return
	}
	_, err = s.db.ExecContext(r.Context(), "INSERT INTO workflow_events(email_id,event_type,idempotency_key) VALUES($1,'queued',$2) ON CONFLICT(idempotency_key) DO NOTHING", e.ID, e.ID+":queued")
	if err != nil {
		s.log.Error("queued event", "error", err)
	}
	payload := map[string]string{"email_id": e.ID, "external_message_id": e.ExternalMessageID, "sender": e.Sender, "subject": e.Subject, "body": e.Body}
	if !s.syncProcessing {
		go s.triggerIntake(payload, e.ID)
		writeJSON(w, 202, e)
		return
	}
	s.triggerIntakeWithContext(r.Context(), payload, e.ID)
	result, loadErr := s.loadEmail(r.Context(), e.ID)
	if loadErr != nil {
		fail(w, 500, "database_error")
		return
	}
	if (result.ProcessingStatus == "processed" && result.Draft != nil) || result.ProcessingStatus == "needs_review" {
		writeJSON(w, 201, result)
		return
	}
	writeJSON(w, 202, result)
}

func (s *server) triggerIntake(payload map[string]string, emailID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	s.triggerIntakeWithContext(ctx, payload, emailID)
}

func (s *server) triggerIntakeWithContext(ctx context.Context, payload map[string]string, emailID string) {
	body, err := json.Marshal(payload)
	if err != nil {
		s.log.Error("encode intake payload", "email_id", emailID)
		return
	}
	req, err := http.NewRequestWithContext(ctx, "POST", s.n8nURL, bytes.NewReader(body))
	if err != nil {
		s.log.Warn("build n8n request", "email_id", emailID, "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(req)
	if err != nil {
		s.log.Warn("n8n unavailable", "email_id", emailID, "error", err)
		return
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
	if response.StatusCode >= 400 {
		s.log.Warn("n8n returned failure", "status", response.StatusCode, "email_id", emailID)
	}
}
func (s *server) listEmails(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), "SELECT "+emailColumns+",(SELECT approval_status FROM drafts WHERE drafts.email_id=emails.id) FROM emails ORDER BY created_at DESC,id DESC LIMIT 100")
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer rows.Close()
	items := []email{}
	for rows.Next() {
		var e email
		eErr := rows.Scan(&e.ID, &e.ExternalMessageID, &e.Sender, &e.Subject, &e.Body, &e.Category, &e.Priority, &e.AssignedTeam, &e.Summary, &e.NeedsReview, &e.ProcessingStatus, &e.CreatedAt, &e.UpdatedAt, &e.RetryAttempts, &e.NextRetryAt, &e.RetryLeaseUntil, &e.LastErrorCode, &e.DraftStatus)
		if eErr != nil {
			fail(w, 500, "database_error")
			return
		}
		items = append(items, e)
	}
	writeJSON(w, 200, items)
}
func (s *server) getEmail(w http.ResponseWriter, r *http.Request) {
	e, err := s.loadEmail(r.Context(), r.PathValue("id"))
	if err == sql.ErrNoRows {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, e)
}
func (s *server) getEvents(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), "SELECT id,email_id,event_type,details,idempotency_key,created_at FROM workflow_events WHERE email_id=$1 ORDER BY created_at,id", r.PathValue("id"))
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, eid, kind, key string
		var details json.RawMessage
		var at time.Time
		if rows.Scan(&id, &eid, &kind, &details, &key, &at) != nil {
			fail(w, 500, "database_error")
			return
		}
		out = append(out, map[string]any{"id": id, "email_id": eid, "event_type": kind, "details": details, "idempotency_key": key, "created_at": at})
	}
	writeJSON(w, 200, out)
}
func validClassification(c classification) bool {
	teams := map[string]string{"billing": "finance", "support": "support", "sales": "sales", "general": "general"}
	team, ok := teams[c.Category]
	return ok && team == c.AssignedTeam && contains([]string{"low", "medium", "high"}, c.Priority) && strings.TrimSpace(c.Summary) != "" && contains([]string{"processed", "needs_review"}, c.ProcessingStatus)
}
func contains(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}
func (s *server) patchClassification(w http.ResponseWriter, r *http.Request) {
	var c classification
	if !decode(w, r, &c) {
		return
	}
	if !validClassification(c) {
		fail(w, 400, "invalid_classification")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRowContext(r.Context(), "UPDATE emails SET category=$2,priority=$3,assigned_team=$4,summary=$5,needs_review=$6,processing_status=$7,updated_at=now() WHERE id=$1 RETURNING id", r.PathValue("id"), c.Category, c.Priority, c.AssignedTeam, strings.TrimSpace(c.Summary), c.NeedsReview, c.ProcessingStatus).Scan(&id)
	if err == sql.ErrNoRows {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	_, err = tx.ExecContext(r.Context(), "INSERT INTO workflow_events(email_id,event_type,idempotency_key) VALUES($1,'classified',$2) ON CONFLICT(idempotency_key) DO NOTHING", id, id+":classified")
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	if tx.Commit() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]string{"status": "stored"})
}
func (s *server) postDraft(w http.ResponseWriter, r *http.Request) {
	var in draftInput
	if !decode(w, r, &in) {
		return
	}
	in.Content = strings.TrimSpace(in.Content)
	if in.Content == "" {
		fail(w, 400, "invalid_draft")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRowContext(r.Context(), "INSERT INTO drafts(email_id,content) VALUES($1,$2) ON CONFLICT(email_id) DO UPDATE SET email_id=EXCLUDED.email_id RETURNING id", r.PathValue("id"), in.Content).Scan(&id)
	if err != nil {
		if strings.Contains(err.Error(), "foreign key") {
			fail(w, 404, "not_found")
		} else {
			fail(w, 500, "database_error")
		}
		return
	}
	_, err = tx.ExecContext(r.Context(), "INSERT INTO workflow_events(email_id,event_type,idempotency_key) VALUES($1,'draft_created',$2) ON CONFLICT(idempotency_key) DO NOTHING", r.PathValue("id"), r.PathValue("id")+":draft_created")
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	if tx.Commit() != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]string{"id": id, "status": "stored"})
}
func (s *server) postEvent(w http.ResponseWriter, r *http.Request) {
	var in eventInput
	if !decode(w, r, &in) {
		return
	}
	if in.EmailID == "" || strings.TrimSpace(in.EventType) == "" || strings.TrimSpace(in.IdempotencyKey) == "" {
		fail(w, 400, "invalid_event")
		return
	}
	if len(in.Details) == 0 {
		in.Details = json.RawMessage(`{}`)
	}
	if !json.Valid(in.Details) {
		fail(w, 400, "invalid_event")
		return
	}
	_, err := s.db.ExecContext(r.Context(), "INSERT INTO workflow_events(email_id,event_type,details,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING", in.EmailID, in.EventType, in.Details, in.IdempotencyKey)
	if err != nil {
		fail(w, 500, "database_error")
		return
	}
	writeJSON(w, 200, map[string]string{"status": "stored"})
}
