package session

import (
	"bytes"
	"context"
	"net"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// ----- 擬似機器（Stream 実装） -----

// fakeDevice は Stream を実装する擬似 NW 機器。書き込まれた行に応じて応答を
// 積み、読み出しはバッファが空なら期限超過エラーを返す（実機の「応答待ち」を
// 待ち時間なしで再現するため）。session.Run の状態機械を実機なしで検証する。
type fakeDevice struct {
	mu sync.Mutex
	// out は読み出し待ちの応答バイト列。
	out bytes.Buffer
	// line は受信中の行（CR で 1 行として処理する）。
	line bytes.Buffer

	prompt        string
	fetchCommand  string
	pagerSuppress string
	body          string

	// 対話ログインを要求するか（Telnet 相当）。
	interactive bool
	username    string
	password    string
	// badPassword が true なら認証を拒否する。
	badPassword bool

	// enablePassword が空でなければ enable 昇格を要求する。
	enablePassword string
	// enabledPrompt は昇格後のプロンプト。
	enabledPrompt string

	loggedIn bool
	enabled  bool
}

func (d *fakeDevice) Read(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.out.Len() == 0 {
		// 応答待ち。net.Error 相当の期限超過として返す。
		return 0, fakeTimeout{}
	}
	return d.out.Read(p)
}

func (d *fakeDevice) Write(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, b := range p {
		if b == '\r' {
			d.handleLine(d.line.String())
			d.line.Reset()
			continue
		}
		d.line.WriteByte(b)
	}
	return len(p), nil
}

func (d *fakeDevice) SetReadDeadline(time.Time) error { return nil }

// currentPrompt は現在のモードに応じたプロンプトを返す。
func (d *fakeDevice) currentPrompt() string {
	if d.enabled && d.enabledPrompt != "" {
		return d.enabledPrompt
	}
	return d.prompt
}

// handleLine は 1 行受信した際の機器側の振る舞いを再現する。
func (d *fakeDevice) handleLine(line string) {
	if d.interactive && !d.loggedIn {
		switch {
		case line == d.username:
			d.out.WriteString("\r\nPassword: ")
		case line == d.password && !d.badPassword:
			d.loggedIn = true
			d.out.WriteString("\r\n" + d.currentPrompt())
		default:
			// 認証拒否 → 再度ログインプロンプトへ戻る。
			d.out.WriteString("\r\n% Login invalid\r\n\r\nUsername: ")
		}
		return
	}

	switch {
	case line == "":
		// 改行のみ → プロンプト再表示（プロンプト学習）。
		d.out.WriteString("\r\n" + d.currentPrompt())
	case line == "enable":
		if d.enablePassword == "" {
			// 既に特権モード。プロンプトをそのまま返す。
			d.out.WriteString("enable\r\n" + d.currentPrompt())
			return
		}
		d.out.WriteString("enable\r\nPassword: ")
	case d.enablePassword != "" && !d.enabled && line == d.enablePassword:
		d.enabled = true
		d.out.WriteString("\r\n" + d.currentPrompt())
	case d.pagerSuppress != "" && line == d.pagerSuppress:
		d.out.WriteString(line + "\r\n" + d.currentPrompt())
	case line == d.fetchCommand:
		// 実機同様「コマンドエコー → 本文 → プロンプト」の順で返す。
		d.out.WriteString(line + "\r\n" + d.body + "\r\n" + d.currentPrompt())
	default:
		d.out.WriteString("\r\n% Invalid input detected\r\n" + d.currentPrompt())
	}
}

// fakeTimeout は net.Error（Timeout() == true）を満たす読み取り期限超過エラー。
type fakeTimeout struct{}

func (fakeTimeout) Error() string   { return "fake read timeout" }
func (fakeTimeout) Timeout() bool   { return true }
func (fakeTimeout) Temporary() bool { return true }

// testConfig はテスト用の短いタイムアウトを持つ Config を返す。
func testConfig(fetchCommand, pagerSuppress string) *Config {
	return &Config{
		Host:           "192.0.2.1",
		Port:           23,
		Username:       "admin",
		Password:       "secret",
		OSHint:         "cisco-ios",
		PagerSuppress:  pagerSuppress,
		FetchCommand:   fetchCommand,
		ConnectTimeout: time.Second,
		LoginTimeout:   2 * time.Second,
		CommandTimeout: 2 * time.Second,
		TotalTimeout:   5 * time.Second,
	}
}

// ----- Run の統合テスト -----

// TestRun_PreAuthenticated は SSH 相当（認証済み）の取得フローを検証する。
func TestRun_PreAuthenticated(t *testing.T) {
	dev := &fakeDevice{
		prompt:        "r1#",
		fetchCommand:  "show running-config",
		pagerSuppress: "terminal length 0",
		body:          "!\nversion 15.0\n!\nhostname r1\n!",
	}
	cfg := testConfig("show running-config", "terminal length 0")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := Run(ctx, dev, cfg, ModePreAuthenticated)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if res.Prompt != "r1#" {
		t.Errorf("Prompt = %q, want %q", res.Prompt, "r1#")
	}
	if !strings.Contains(res.Body, "hostname r1") {
		t.Errorf("Body should contain the config, got %q", res.Body)
	}
	if strings.Contains(res.Body, "show running-config") {
		t.Errorf("Body should not contain the command echo, got %q", res.Body)
	}
	if res.SourceEncoding != "utf-8" {
		t.Errorf("SourceEncoding = %q, want utf-8", res.SourceEncoding)
	}
}

// TestRun_InteractiveLogin は Telnet 相当（対話ログイン）の取得フローを検証する。
func TestRun_InteractiveLogin(t *testing.T) {
	dev := &fakeDevice{
		prompt:       "rtx>",
		fetchCommand: "show config",
		body:         "ip route default gateway 10.0.0.1",
		interactive:  true,
		username:     "admin",
		password:     "secret",
	}
	// ログインプロンプトを最初から提示している状態。
	dev.out.WriteString("\r\nWelcome\r\n\r\nUsername: ")

	cfg := testConfig("show config", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := Run(ctx, dev, cfg, ModeInteractiveLogin)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if res.Prompt != "rtx>" {
		t.Errorf("Prompt = %q, want %q", res.Prompt, "rtx>")
	}
	if res.Body != "ip route default gateway 10.0.0.1" {
		t.Errorf("Body = %q", res.Body)
	}
}

// TestRun_InteractiveLoginAuthFailed は認証拒否が auth_failed になることを検証する。
func TestRun_InteractiveLoginAuthFailed(t *testing.T) {
	dev := &fakeDevice{
		prompt:       "r1#",
		fetchCommand: "show running-config",
		interactive:  true,
		username:     "admin",
		password:     "secret",
		badPassword:  true,
	}
	dev.out.WriteString("\r\nUsername: ")

	cfg := testConfig("show running-config", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := Run(ctx, dev, cfg, ModeInteractiveLogin)
	if err == nil {
		t.Fatal("Run should fail with auth_failed")
	}
	var se *Error
	if !asError(err, &se) {
		t.Fatalf("error should be *Error, got %T", err)
	}
	if se.Code != CodeAuthFailed {
		t.Errorf("Code = %q, want %q", se.Code, CodeAuthFailed)
	}
}

// TestRun_Enable は enable 昇格後にプロンプトを再学習することを検証する。
func TestRun_Enable(t *testing.T) {
	dev := &fakeDevice{
		prompt:         "r1>",
		enabledPrompt:  "r1#",
		enablePassword: "enablepass",
		fetchCommand:   "show running-config",
		body:           "hostname r1",
	}
	cfg := testConfig("show running-config", "")
	cfg.EnablePassword = "enablepass"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := Run(ctx, dev, cfg, ModePreAuthenticated)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if res.Prompt != "r1#" {
		t.Errorf("Prompt = %q, want %q（昇格後のプロンプトを学習すべき）", res.Prompt, "r1#")
	}
}

// TestRun_EnableAlreadyPrivileged は既に特権モードの機器（enable で Password を
// 求められない）でも成功することを検証する。
func TestRun_EnableAlreadyPrivileged(t *testing.T) {
	dev := &fakeDevice{
		prompt:       "r1#",
		fetchCommand: "show running-config",
		body:         "hostname r1",
		// enablePassword を空にすることで「Password を求めない機器」を再現。
	}
	cfg := testConfig("show running-config", "")
	cfg.EnablePassword = "enablepass"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := Run(ctx, dev, cfg, ModePreAuthenticated)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if res.Body != "hostname r1" {
		t.Errorf("Body = %q", res.Body)
	}
}

// TestRun_PagerDetected は本文にページャマーカが残る場合の失敗を検証する。
func TestRun_PagerDetected(t *testing.T) {
	dev := &fakeDevice{
		prompt:       "r1#",
		fetchCommand: "show running-config",
		body:         "hostname r1\r\n--More--",
	}
	cfg := testConfig("show running-config", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := Run(ctx, dev, cfg, ModePreAuthenticated)
	var se *Error
	if err == nil || !asError(err, &se) || se.Code != CodePagerDetected {
		t.Fatalf("want pager_detected, got %v", err)
	}
}

// TestRun_EmptyFetchCommand は取得コマンド未指定を実行前に弾くことを検証する。
func TestRun_EmptyFetchCommand(t *testing.T) {
	dev := &fakeDevice{prompt: "r1#"}
	cfg := testConfig("", "")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := Run(ctx, dev, cfg, ModePreAuthenticated)
	var se *Error
	if err == nil || !asError(err, &se) || se.Code != CodeEmptyBody {
		t.Fatalf("want empty_body, got %v", err)
	}
}

// asError は *Error への型アサーション（テスト用の小さなヘルパ）。
func asError(err error, target **Error) bool {
	se, ok := err.(*Error)
	if ok {
		*target = se
	}
	return ok
}

// ----- 純粋関数のテスト -----

func TestExtractPromptFromTail(t *testing.T) {
	tests := []struct {
		name  string
		text  string
		want  string
		found bool
	}{
		{
			name:  "cisco prompt with hash",
			text:  "\r\nbanner line\r\nrouter#",
			want:  "router#",
			found: true,
		},
		{
			name:  "user mode prompt with gt",
			text:  "router>",
			want:  "router>",
			found: true,
		},
		{
			name:  "config mode prompt",
			text:  "router(config)#",
			want:  "router(config)#",
			found: true,
		},
		{
			name:  "banner before prompt - last non-empty wins",
			text:  "MOTD line 1\nMOTD line 2\n\nrouter#",
			want:  "router#",
			found: true,
		},
		{
			name:  "trailing spaces and newlines",
			text:  "router#   \n\n",
			want:  "router#",
			found: true,
		},
		{
			name:  "no prompt symbol",
			text:  "just some text without prompt",
			want:  "",
			found: false,
		},
		{
			name:  "empty text",
			text:  "",
			want:  "",
			found: false,
		},
		{
			name:  "yamaha prompt",
			text:  "RTX810>",
			want:  "RTX810>",
			found: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, found := extractPromptFromTail(tt.text)
			if found != tt.found {
				t.Errorf("found = %v, want %v", found, tt.found)
			}
			if got != tt.want {
				t.Errorf("prompt = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCleanBody(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		prompt  string
		command string
		want    string
	}{
		{
			name:    "cisco running-config",
			text:    "router#show running-config\r\n!\nversion 15.0\n!\nhostname router\n!\nrouter#",
			prompt:  "router#",
			command: "show running-config",
			want:    "!\nversion 15.0\n!\nhostname router\n!",
		},
		{
			name:    "banner before command echo is stripped",
			text:    "Welcome to Router\r\nAuthorized users only\r\nrouter#show config\r\nip route 0.0.0.0 0.0.0.0 10.0.0.1\nrouter#",
			prompt:  "router#",
			command: "show config",
			want:    "ip route 0.0.0.0 0.0.0.0 10.0.0.1",
		},
		{
			name:    "prompt only lines removed",
			text:    "rtx>show config\nrouter#show config\ndata\nrouter#",
			prompt:  "router#",
			command: "show config",
			want:    "data",
		},
		{
			name:    "config mode prompt in body line not starting with prompt",
			text:    "r1#show run\ninterface GigabitEthernet0/0\nr1#",
			prompt:  "r1#",
			command: "show run",
			want:    "interface GigabitEthernet0/0",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cleanBody(tt.text, tt.prompt, tt.command)
			if got != tt.want {
				t.Errorf("cleanBody = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPagerMarkerRe(t *testing.T) {
	tests := []struct {
		text string
		want bool
	}{
		{"--More--", true},
		{"  --More--  ", true},
		{"---- More ----", true},
		{"--MORE--", true},
		{"some config\n--More--\nmore config", true},
		{"no pager here", false},
		{"running-config", false},
	}
	for _, tt := range tests {
		t.Run(tt.text, func(t *testing.T) {
			if got := pagerMarkerRe.MatchString(tt.text); got != tt.want {
				t.Errorf("MatchString(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestEndsWithPrompt(t *testing.T) {
	tests := []struct {
		data   string
		prompt string
		want   bool
	}{
		{"some output\r\nrouter#", "router#", true},
		{"some output\r\nrouter#   \r\n", "router#", true},
		{"some output", "router#", false},
		{"router#show run", "router#", false}, // プロンプトの後に文字がある
		{"router#", "router#", true},
	}
	for _, tt := range tests {
		t.Run(tt.data, func(t *testing.T) {
			if got := endsWithPrompt([]byte(tt.data), []byte(tt.prompt)); got != tt.want {
				t.Errorf("endsWithPrompt(%q, %q) = %v, want %v", tt.data, tt.prompt, got, tt.want)
			}
		})
	}
}

func TestAuthFailedSignal(t *testing.T) {
	tests := []struct {
		text string
		want bool
	}{
		{"% Login invalid\nPassword:", true},
		{"Login invalid", true},
		{"Access denied", true},
		{"% Bad passwords", true},
		{"Password:", true}, // 成功プロンプトなしの Password 再入力要求
		{"router#", false},  // プロンプトがあれば成功
		{"router>", false},
	}
	for _, tt := range tests {
		t.Run(tt.text, func(t *testing.T) {
			if got := authFailedSignal(tt.text); got != tt.want {
				t.Errorf("authFailedSignal(%q) = %v, want %v", tt.text, got, tt.want)
			}
		})
	}
}

func TestCommandRejected(t *testing.T) {
	tests := []struct {
		name string
		body string
		want bool
	}{
		{
			// SWX3100 に YAMAHA RT 用の "show config" を送ったときの実応答。
			name: "cisco style invalid input",
			body: "                          ^\n% Invalid input detected at '^' marker.",
			want: true,
		},
		{
			name: "unknown command",
			body: "% Unknown command.",
			want: true,
		},
		{
			name: "incomplete command",
			body: "% Incomplete command.",
			want: true,
		},
		{
			name: "ambiguous command",
			body: "% Ambiguous command: \"sh conf\"",
			want: true,
		},
		{
			name: "permission denied",
			body: "% Permission denied",
			want: true,
		},
		{
			name: "yamaha rt japanese error",
			body: "エラー: コマンドが違います",
			want: true,
		},
		{
			name: "shell command not found",
			body: "-sh: show: command not found",
			want: true,
		},
		{
			name: "normal config is not rejected",
			body: "!\nhostname swx3100\n!\ninterface port1.1\n switchport mode access\n!\nend",
			want: false,
		},
		{
			// 本文が十分に長ければ、途中の "%" 行は誤検出とみなして通す。
			name: "long body with percent line passes",
			body: "!\nhostname r1\n" + strings.Repeat("line\n", 20) +
				"% Invalid input detected at '^' marker.\n" + strings.Repeat("line\n", 20),
			want: false,
		},
		{
			name: "empty body",
			body: "   \n  ",
			want: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg, got := commandRejected(tt.body)
			if got != tt.want {
				t.Errorf("commandRejected() = %v, want %v (msg=%q)", got, tt.want, msg)
			}
			if got && msg == "" {
				t.Error("rejected but message is empty")
			}
		})
	}
}

// TestWaitForAny は「どのパターンにマッチしたか」が正しく返ることを検証する。
// net.Pipe の net.Conn をそのまま Stream として渡す（Read/Write/SetReadDeadline
// を満たすため）。
//
// 回帰防止: 以前の実装は promptLineRe を単独で渡した場合でも「プロンプトが
// 先に出た」エラーを返しており、ページング抑制後やenable昇格後のプロンプト
// 待ちが必ず失敗していた（症状: unexpected prompt before login）。
func TestWaitForAny(t *testing.T) {
	tests := []struct {
		name    string
		send    string
		res     []*regexp.Regexp
		wantIdx int
	}{
		{
			// ページング抑制後・enable 昇格後のプロンプト待ち。
			name:    "prompt only succeeds",
			send:    "swx3100#",
			res:     []*regexp.Regexp{promptLineRe},
			wantIdx: 0,
		},
		{
			name:    "username prompt wins",
			send:    "\r\nUsername: ",
			res:     []*regexp.Regexp{loginPromptRe, passwordRe, promptLineRe},
			wantIdx: 0,
		},
		{
			// ユーザー名を求めず、いきなり Password を出す機器。
			name:    "password prompt without username",
			send:    "\r\nPassword: ",
			res:     []*regexp.Regexp{loginPromptRe, passwordRe, promptLineRe},
			wantIdx: 1,
		},
		{
			// 認証なしでプロンプトが出る機器。
			name:    "shell prompt means no auth",
			send:    "\r\nrt1>",
			res:     []*regexp.Regexp{loginPromptRe, passwordRe, promptLineRe},
			wantIdx: 2,
		},
		{
			name:    "enable asks for password",
			send:    "\r\nPassword: ",
			res:     []*regexp.Regexp{passwordRe, promptLineRe},
			wantIdx: 0,
		},
		{
			// enable 済みならプロンプトがそのまま返る。
			name:    "enable already privileged",
			send:    "\r\nswx3100#",
			res:     []*regexp.Regexp{passwordRe, promptLineRe},
			wantIdx: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			// 接続は閉じない。閉じると waitForAny が EOF を読み取り、
			// マッチ判定に到達する前に read error として返ってしまう。
			defer server.Close()
			go func() { _, _ = server.Write([]byte(tt.send)) }()
			idx, err := waitForAny(
				context.Background(), client, 3*time.Second, tt.res...,
			)
			if err != nil {
				t.Fatalf("waitForAny() error = %v", err)
			}
			if idx != tt.wantIdx {
				t.Errorf("waitForAny() idx = %d, want %d", idx, tt.wantIdx)
			}
		})
	}
}
