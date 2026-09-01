package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRedeemEndpoint(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		want    string
		wantErr bool
	}{
		{
			name:   "https origin is accepted",
			origin: "https://config.example.com",
			want:   "https://config.example.com/helper/credentials/redeem",
		},
		{
			name:   "trailing slash is trimmed",
			origin: "https://config.example.com/",
			want:   "https://config.example.com/helper/credentials/redeem",
		},
		{
			name:   "http localhost is allowed for development",
			origin: "http://localhost:3000",
			want:   "http://localhost:3000/helper/credentials/redeem",
		},
		{
			name:   "http loopback ip is allowed for development",
			origin: "http://127.0.0.1:5173",
			want:   "http://127.0.0.1:5173/helper/credentials/redeem",
		},
		{
			// 平文 HTTP でリモートへ送ると、トークンとパスワードが平文で流れる。
			name:    "plaintext http to a remote host is refused",
			origin:  "http://config.example.com",
			wantErr: true,
		},
		{
			name:    "empty origin is refused",
			origin:  "",
			wantErr: true,
		},
		{
			name:    "origin without a host is refused",
			origin:  "https://",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := redeemEndpoint(tc.origin)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("redeemEndpoint(%q) = %q, want error", tc.origin, got)
				}
				if !errors.Is(err, errRedeemFailed) {
					t.Fatalf("error should wrap errRedeemFailed, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("redeemEndpoint(%q) returned unexpected error: %v", tc.origin, err)
			}
			if got != tc.want {
				t.Fatalf("redeemEndpoint(%q) = %q, want %q", tc.origin, got, tc.want)
			}
		})
	}
}

func TestRedeemCredentialSuccess(t *testing.T) {
	var gotBody map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != credentialRedeemPath {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method %q", r.Method)
		}
		// トークンは URL ではなくボディで運ぶこと。
		if strings.Contains(r.URL.RawQuery, "token") {
			t.Errorf("token must not appear in the query string: %q", r.URL.RawQuery)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		writeJSON(w, http.StatusOK, redeemedCredential{
			Username: "admin",
			Password: "s3cret",
		})
	}))
	defer srv.Close()

	// httptest は http://127.0.0.1:<port> を返すのでループバック例外で通る。
	got, err := redeemCredential(
		context.Background(), srv.URL, "test-token", "helper-id", "192.0.2.1", "signature",
	)
	if err != nil {
		t.Fatalf("redeemCredential returned an error: %v", err)
	}
	if got.Username != "admin" || got.Password != "s3cret" {
		t.Fatalf("unexpected credential: username=%q", got.Username)
	}
	if gotBody["token"] != "test-token" {
		t.Fatalf("token was not sent in the body, got %v", gotBody)
	}
	if gotBody["helperId"] != "helper-id" || gotBody["targetHost"] != "192.0.2.1" || gotBody["signature"] != "signature" {
		t.Fatalf("helper binding was not sent in the body, got %v", gotBody)
	}
}

func TestRedeemCredentialRejectsFailures(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{
			name: "non-200 status",
			handler: func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "token is invalid or expired"})
			},
		},
		{
			name: "malformed body",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("not json"))
			},
		},
		{
			// パスワードが空のまま機器へ接続を試みると、無意味な認証失敗になる。
			name: "empty password",
			handler: func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, http.StatusOK, redeemedCredential{Username: "admin"})
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.handler)
			defer srv.Close()

			got, err := redeemCredential(
				context.Background(), srv.URL, "test-token", "helper-id", "192.0.2.1", "signature",
			)
			if err == nil {
				t.Fatalf("expected an error, got credential for %q", got.Username)
			}
			if !errors.Is(err, errRedeemFailed) {
				t.Fatalf("error should wrap errRedeemFailed, got %v", err)
			}
		})
	}
}
