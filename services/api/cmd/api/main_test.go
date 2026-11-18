package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidation(t *testing.T) {
	e := createEmail{ExternalMessageID: " id ", Sender: " a@example.com ", Subject: " Hi ", Body: " Body "}
	trimEmail(&e)
	if !validEmail(e) || e.ExternalMessageID != "id" || e.Subject != "Hi" {
		t.Fatal("valid email rejected or not normalized")
	}
	e.Subject = "  "
	trimEmail(&e)
	if validEmail(e) {
		t.Fatal("blank subject accepted")
	}
	if !validClassification(classification{Category: "billing", Priority: "high", AssignedTeam: "finance", Summary: "Duplicate charge", ProcessingStatus: "processed"}) {
		t.Fatal("valid classification rejected")
	}
	if validClassification(classification{Category: "unknown", Priority: "high", Summary: "x", ProcessingStatus: "processed"}) {
		t.Fatal("unknown category accepted")
	}
}

func TestReliabilityRules(t *testing.T) {
	s := &server{slaSeconds: map[string]int{"high": 5, "medium": 60, "low": 120}}
	start := time.Unix(1000, 0)
	if got := s.deadline("high", start); !got.Equal(start.Add(5 * time.Second)) {
		t.Fatalf("high deadline: %v", got)
	}
	if got := s.deadline("unknown", start); !got.Equal(start.Add(60 * time.Second)) {
		t.Fatalf("fallback deadline: %v", got)
	}
	if retryBackoff(3*time.Second, 1) != 3*time.Second || retryBackoff(3*time.Second, 3) != 12*time.Second {
		t.Fatal("backoff is not exponential")
	}
	if safeCode(" Open Router/Timeout ") != "open_router_timeout" {
		t.Fatal("error code not normalized")
	}
	if strings.Contains(safeLabel("Bearer secret-token user@example.com", 240), "secret-token") {
		t.Fatal("secret was not redacted")
	}
}

func TestInternalAuth(t *testing.T) {
	s := &server{token: "test-secret"}
	handler := s.auth(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	for _, tc := range []struct {
		token string
		want  int
	}{{"", 401}, {"wrong", 401}, {"test-secret", 204}} {
		req := httptest.NewRequest("PATCH", "/internal/emails/id/classification", strings.NewReader("{}"))
		req.Header.Set("X-MailPilot-Token", tc.token)
		rr := httptest.NewRecorder()
		handler(rr, req)
		if rr.Code != tc.want {
			t.Fatalf("token %q: got %d", tc.token, rr.Code)
		}
	}
}

func TestFrontendAuth(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	s := &server{frontendToken: "frontend-secret"}
	handler := s.frontend(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	for _, tc := range []struct {
		token string
		want  int
	}{{"", 401}, {"wrong", 401}, {"frontend-secret", 204}} {
		req := httptest.NewRequest("GET", "/emails", nil)
		req.Header.Set("X-MailPilot-Frontend-Token", tc.token)
		rr := httptest.NewRecorder()
		handler(rr, req)
		if rr.Code != tc.want {
			t.Fatalf("token %q: got %d", tc.token, rr.Code)
		}
	}
}

func TestEmailSimulationRateLimit(t *testing.T) {
	s := &server{rateLimit: 2, rateWindows: map[string]rateWindow{}}
	handler := s.limitEmailCreation(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	for i, want := range []int{204, 204, 429} {
		req := httptest.NewRequest("POST", "/emails", nil)
		req.Header.Set("X-MailPilot-Actor", "demo@example.com")
		rr := httptest.NewRecorder()
		handler(rr, req)
		if rr.Code != want {
			t.Fatalf("request %d: got %d", i+1, rr.Code)
		}
	}
}

func TestReviewDraftValidation(t *testing.T) {
	s := &server{}
	for _, tc := range []struct {
		body string
		code string
	}{
		{`{}`, `empty_update`},
		{`{"content":"  "}`, `invalid_draft`},
		{`{"approval_status":"sent"}`, `invalid_approval_status`},
		{`{"unknown":true}`, `invalid_json`},
	} {
		req := httptest.NewRequest("PATCH", "/emails/id/draft", strings.NewReader(tc.body))
		rr := httptest.NewRecorder()
		s.reviewDraft(rr, req)
		if rr.Code != 400 || !strings.Contains(rr.Body.String(), tc.code) {
			t.Fatalf("body %s: got %d %s", tc.body, rr.Code, rr.Body.String())
		}
	}
}
