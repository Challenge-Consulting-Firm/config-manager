package commands

import (
	"errors"
	"strings"
	"testing"
)

// TestValidateOverride_Freeform は都度入力の認証情報を使う経路（自由入力可）の検証。
func TestValidateOverride_Freeform(t *testing.T) {
	tests := []struct {
		name    string
		osHint  string
		raw     string
		want    string
		wantErr error
	}{
		{
			name:   "単一コマンドはそのまま通る",
			osHint: OsHintCiscoIOS,
			raw:    "show running-config",
			want:   "show running-config",
		},
		{
			name:   "未サポート機種の読み取りコマンドも通る",
			osHint: OsHintGeneric,
			raw:    "show full-configuration",
			want:   "show full-configuration",
		},
		{
			name:   "先頭・末尾の空白は除去される",
			osHint: OsHintCiscoIOS,
			raw:    "   show running-config \t ",
			// タブは制御文字のため拒否される（下の制御文字ケースを参照）。
			wantErr: ErrOverrideControlChar,
		},
		{
			name:   "先頭・末尾の半角空白は除去される",
			osHint: OsHintCiscoIOS,
			raw:    "   show running-config   ",
			want:   "show running-config",
		},
		{
			name:   "内部の連続空白は 1 個へ畳まれる",
			osHint: OsHintCiscoIOS,
			raw:    "show    running-config",
			want:   "show running-config",
		},
		{
			name:    "CRLF 注入は拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show running-config\r\nreload",
			wantErr: ErrOverrideControlChar,
		},
		{
			name:    "CR 単体の注入は拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show running-config\rconfigure terminal",
			wantErr: ErrOverrideControlChar,
		},
		{
			name:    "LF 単体の注入は拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show running-config\nreload",
			wantErr: ErrOverrideControlChar,
		},
		{
			name:    "NUL は拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show running-config\x00reload",
			wantErr: ErrOverrideControlChar,
		},
		{
			name:    "エスケープシーケンスは拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show version\x1b[2J",
			wantErr: ErrOverrideControlChar,
		},
		{
			name:    "Unicode 行区切りは拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show version\u2028reload",
			wantErr: ErrOverrideControlChar,
		},
		{
			name:    "空文字は拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "",
			wantErr: ErrOverrideEmpty,
		},
		{
			name:    "空白のみは拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "     ",
			wantErr: ErrOverrideEmpty,
		},
		{
			name:    "長すぎるコマンドは拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show " + strings.Repeat("a", MaxOverrideLen),
			wantErr: ErrOverrideTooLong,
		},
		{
			name:    "設定変更コマンドは拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "configure terminal",
			wantErr: ErrOverrideNotReadOnly,
		},
		{
			name:    "reload は拒否される",
			osHint:  OsHintGeneric,
			raw:     "reload",
			wantErr: ErrOverrideNotReadOnly,
		},
		{
			name:    "セミコロン連結は拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show version; reload",
			wantErr: ErrOverrideCharset,
		},
		{
			name:    "パイプは拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show running-config | include secret",
			wantErr: ErrOverrideCharset,
		},
		{
			name:    "コマンド置換は拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show version $(reload)",
			wantErr: ErrOverrideCharset,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateOverride(tt.osHint, tt.raw, true)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				if got != "" {
					t.Fatalf("拒否時にコマンドを返している: %q", got)
				}
				// 拒否理由に入力コマンドが混ざっていないこと（ログへ流れるため）。
				if strings.Contains(err.Error(), "reload") || strings.Contains(err.Error(), "running-config") {
					t.Fatalf("エラーメッセージに入力コマンドが含まれている: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

// TestValidateOverride_StoredCredential は保存済み認証情報を使う経路
// （定義済み読み取り専用コマンドのみ許可）の検証。
func TestValidateOverride_StoredCredential(t *testing.T) {
	tests := []struct {
		name    string
		osHint  string
		raw     string
		want    string
		wantErr error
	}{
		{
			name:   "定義済みコマンドは通る",
			osHint: OsHintCiscoIOS,
			raw:    "show startup-config",
			want:   "show startup-config",
		},
		{
			name:   "大文字小文字は区別しない",
			osHint: OsHintCiscoIOS,
			raw:    "SHOW RUNNING-CONFIG",
			want:   "SHOW RUNNING-CONFIG",
		},
		{
			name:   "YAMAHA RT の定義済みコマンドは通る",
			osHint: OsHintYamahaRT,
			raw:    "show config",
			want:   "show config",
		},
		{
			name:    "定義済み以外の読み取りコマンドでも拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show tech-support",
			wantErr: ErrOverrideNotAllowed,
		},
		{
			name:    "osHint に無い読み取りコマンドは拒否される",
			osHint:  OsHintYamahaRT,
			raw:     "show running-config",
			wantErr: ErrOverrideNotAllowed,
		},
		{
			name:    "CRLF 注入は拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "show running-config\r\nreload",
			wantErr: ErrOverrideControlChar,
		},
		{
			name:    "設定変更コマンドは拒否される",
			osHint:  OsHintCiscoIOS,
			raw:     "configure terminal",
			wantErr: ErrOverrideNotAllowed,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateOverride(tt.osHint, tt.raw, false)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

// TestDefaultCommandsPassValidation は osHint 既定コマンドが従来どおり
// 送信可能であることを確認する（回帰防止）。
func TestDefaultCommandsPassValidation(t *testing.T) {
	for _, osHint := range []string{OsHintCiscoIOS, OsHintYamahaRT, OsHintYamahaSWX, OsHintGeneric} {
		set := Lookup(osHint)
		if err := ValidateCommandLine(set.PagerSuppress); err != nil {
			t.Errorf("%s: PagerSuppress が検証で拒否された: %v", osHint, err)
		}
		if set.Fetch == "" {
			continue // generic は commandOverride 必須
		}
		if err := ValidateCommandLine(set.Fetch); err != nil {
			t.Errorf("%s: Fetch が検証で拒否された: %v", osHint, err)
		}
		// 既定コマンドは保存済み認証情報の経路でも上書きとして指定できること。
		if _, err := ValidateOverride(osHint, set.Fetch, false); err != nil {
			t.Errorf("%s: 既定コマンドが allowlist に含まれていない: %v", osHint, err)
		}
	}
}

func TestValidateCommandLine(t *testing.T) {
	if err := ValidateCommandLine(""); err != nil {
		t.Fatalf("空文字は制御文字検証を通ること: %v", err)
	}
	if err := ValidateCommandLine("show running-config"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, bad := range []string{"a\rb", "a\nb", "a\x00b", "a\tb", "a\x7fb", "a\u2029b"} {
		if err := ValidateCommandLine(bad); !errors.Is(err, ErrOverrideControlChar) {
			t.Errorf("%q: err = %v, want ErrOverrideControlChar", bad, err)
		}
	}
}
