package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testOrigin = "http://localhost:5173"

// postFetch は /api/fetch へ POST し、応答を返す。
func postFetch(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	s, err := New(Config{AllowedOrigins: []string{testOrigin}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/fetch", strings.NewReader(body))
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	return rec
}

// TestHandleFetch_RejectsCommandOverrideInjection は、commandOverride に制御文字を
// 含む要求を機器へ接続する前に 400 で拒否することを検証する（Issue #76）。
// 応答本文へ入力コマンドを混ぜないことも併せて確認する。
func TestHandleFetch_RejectsCommandOverrideInjection(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "CRLF 注入",
			body: `{"host":"192.0.2.1","protocol":"telnet","username":"admin","password":"pw","osHint":"cisco-ios","commandOverride":"show running-config\r\nreload"}`,
		},
		{
			name: "NUL 混入",
			body: `{"host":"192.0.2.1","protocol":"telnet","username":"admin","password":"pw","osHint":"cisco-ios","commandOverride":"show running-config\u0000reload"}`,
		},
		{
			name: "設定変更コマンド",
			body: `{"host":"192.0.2.1","protocol":"telnet","username":"admin","password":"pw","osHint":"generic","commandOverride":"configure terminal"}`,
		},
		{
			name: "メタ文字による連結",
			body: `{"host":"192.0.2.1","protocol":"telnet","username":"admin","password":"pw","osHint":"generic","commandOverride":"show version; reload"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := postFetch(t, tt.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "reload") ||
				strings.Contains(rec.Body.String(), "configure") {
				t.Fatalf("応答へ入力コマンドが反射されている: %s", rec.Body.String())
			}
		})
	}
}

// TestHandleFetch_StoredCredentialRejectsFreeformCommand は、保存済み認証情報
// （credentialToken）と定義済み以外のコマンドの組み合わせを拒否することを検証する。
// 読み取り専用の形をしたコマンドであっても、トークン経路では許可しない。
func TestHandleFetch_StoredCredentialRejectsFreeformCommand(t *testing.T) {
	body := `{"host":"192.0.2.1","protocol":"telnet","credentialToken":"dummy-token","osHint":"cisco-ios","commandOverride":"show tech-support"}`
	rec := postFetch(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "dummy-token") {
		t.Fatalf("応答へトークンが含まれている: %s", rec.Body.String())
	}
}
