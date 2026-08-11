package telnet

import (
	"testing"
)

// TestStripIAC_Negotiation は DO/WILL ネゴシエーションを除去し、
// 消極応答（WONT/DONT）を生成することを検証する。
func TestStripIAC_Negotiation(t *testing.T) {
	// "router>" の前に WILL SGA (IAC WILL 3) と DO TERM (IAC DO 24) が来るケース。
	raw := []byte{iac, will, 3, 'r', 'o', 'u', 't', 'e', 'r', '>', iac, do, 24}
	clean, resp := (&iacParser{}).stripIAC(raw)
	if got := string(clean); got != "router>" {
		t.Errorf("clean = %q, want %q", got, "router>")
	}
	// resp は "IAC DONT 3 IAC WONT 24" を含むべき。
	wantResp := []byte{iac, dont, 3, iac, wont, 24}
	if string(resp) != string(wantResp) {
		t.Errorf("resp = %v, want %v", resp, wantResp)
	}
}

// TestStripIAC_Subnegotiation は IAC SB ... IAC SE をスキップすることを検証する。
func TestStripIAC_Subnegotiation(t *testing.T) {
	// "hello" + IAC SB 24 1 IAC SE + "world"
	raw := []byte{'h', 'e', 'l', 'l', 'o', iac, sb, 24, 1, iac, se, 'w', 'o', 'r', 'l', 'd'}
	clean, resp := (&iacParser{}).stripIAC(raw)
	if got := string(clean); got != "helloworld" {
		t.Errorf("clean = %q, want %q", got, "helloworld")
	}
	if len(resp) != 0 {
		t.Errorf("resp should be empty, got %v", resp)
	}
}

// TestStripIAC_EscapedFF は IAC IAC（エスケープされた 0xFF）を検証する。
func TestStripIAC_EscapedFF(t *testing.T) {
	raw := []byte{0x01, iac, iac, 0x02}
	clean, _ := (&iacParser{}).stripIAC(raw)
	if got := string(clean); got != "\x01\xff\x02" {
		t.Errorf("clean = %q, want %q", got, "\x01\xff\x02")
	}
}

// TestStripIAC_NoCommands は IAC が含まれない場合はそのまま通すことを検証する。
func TestStripIAC_NoCommands(t *testing.T) {
	raw := []byte("plain text no commands here")
	clean, resp := (&iacParser{}).stripIAC(raw)
	if string(clean) != string(raw) {
		t.Errorf("clean should equal raw")
	}
	if len(resp) != 0 {
		t.Errorf("resp should be empty")
	}
}

// TestExtractPromptFromTail はプロンプト学習ロジックを検証する。
// banner MOTD があっても最後の非空行を採用することを確認する。
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

// TestCleanBody はコマンドエコー・プロンプト行除去を検証する。
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

// TestPagerMarkerRe はページャマーカ検出を検証する。
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

// TestEndsWithPrompt はプロンプト終端判定を検証する。
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

// TestAuthFailedSignal は認証失敗検出を検証する。
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

// TestIACParser_SplitDO は「IAC DO」が 2 チャンクに分割されたケースを検証する。
// チャンク1 = "route" + IAC、チャンク2 = DO 24 + "r>"。
// 旧実装では IAC 単独を破棄し、DO を通常テキストとして処理していた。
func TestIACParser_SplitDO(t *testing.T) {
	p := &iacParser{}
	// 1 回目: "route" + IAC（未確定）。
	clean1, resp1 := p.stripIAC([]byte{'r', 'o', 'u', 't', 'e', iac})
	if got := string(clean1); got != "route" {
		t.Errorf("clean1 = %q, want %q", got, "route")
	}
	if len(resp1) != 0 {
		t.Errorf("resp1 should be empty, got %v", resp1)
	}
	// 2 回目: DO 24 + "r>"。pending の IAC と結合して解釈される。
	clean2, resp2 := p.stripIAC([]byte{do, 24, 'r', '>'})
	if got := string(clean2); got != "r>" {
		t.Errorf("clean2 = %q, want %q", got, "r>")
	}
	// resp2 は IAC WONT 24 を含むべき。
	wantResp := []byte{iac, wont, 24}
	if string(resp2) != string(wantResp) {
		t.Errorf("resp2 = %v, want %v", resp2, wantResp)
	}
	if len(p.pending) != 0 {
		t.Errorf("pending should be empty after complete sequence, got %v", p.pending)
	}
}

// TestIACParser_SplitWILL は「IAC WILL」の option バイトが次チャンクに来るケース。
func TestIACParser_SplitWILL(t *testing.T) {
	p := &iacParser{}
	// 1 回目: IAC WILL（option 未確定）。
	clean1, resp1 := p.stripIAC([]byte{iac, will})
	if len(clean1) != 0 {
		t.Errorf("clean1 should be empty, got %q", clean1)
	}
	if len(resp1) != 0 {
		t.Errorf("resp1 should be empty")
	}
	// 2 回目: option 3 + "text"。
	clean2, resp2 := p.stripIAC([]byte{3, 't', 'e', 'x', 't'})
	if got := string(clean2); got != "text" {
		t.Errorf("clean2 = %q, want %q", got, "text")
	}
	wantResp := []byte{iac, dont, 3}
	if string(resp2) != string(wantResp) {
		t.Errorf("resp2 = %v, want %v", resp2, wantResp)
	}
}

// TestIACParser_SplitSubnegotiation は IAC SB ... IAC SE が
// 複数チャンクに分割されたケースを検証する。
func TestIACParser_SplitSubnegotiation(t *testing.T) {
	p := &iacParser{}
	// 1 回目: "he" + IAC SB 24 1（サブネゴ開始、未確定）。
	clean1, _ := p.stripIAC([]byte{'h', 'e', iac, sb, 24, 1})
	if got := string(clean1); got != "he" {
		t.Errorf("clean1 = %q, want %q", got, "he")
	}
	if !p.inSubneg {
		t.Error("inSubneg should be true after IAC SB")
	}
	// 2 回目: サブネゴ内容 + IAC（未確定）。
	clean2, _ := p.stripIAC([]byte{0x01, 0x02, iac})
	if len(clean2) != 0 {
		t.Errorf("clean2 should be empty (in subneg), got %q", clean2)
	}
	// 3 回目: SE + "llo"。サブネゴ終了。
	clean3, resp3 := p.stripIAC([]byte{se, 'l', 'l', 'o'})
	if got := string(clean3); got != "llo" {
		t.Errorf("clean3 = %q, want %q", got, "llo")
	}
	if len(resp3) != 0 {
		t.Errorf("resp3 should be empty")
	}
	if p.inSubneg {
		t.Error("inSubneg should be false after IAC SE")
	}
}

// TestIACParser_SplitEscapedFF は IAC IAC（0xFF エスケープ）が
// 2 チャンクに分割されたケースを検証する。
func TestIACParser_SplitEscapedFF(t *testing.T) {
	p := &iacParser{}
	// 1 回目: 0x01 + IAC（未確定）。
	clean1, resp1 := p.stripIAC([]byte{0x01, iac})
	if got := string(clean1); got != "\x01" {
		t.Errorf("clean1 = %q, want %q", got, "\x01")
	}
	if len(resp1) != 0 {
		t.Errorf("resp1 should be empty")
	}
	// 2 回目: IAC + 0x02。エスケープ完了 → 0xFF が出力される。
	clean2, resp2 := p.stripIAC([]byte{iac, 0x02})
	if got := string(clean2); got != "\xff\x02" {
		t.Errorf("clean2 = %q, want %q", got, "\xff\x02")
	}
	if len(resp2) != 0 {
		t.Errorf("resp2 should be empty")
	}
}

// TestIACParser_MultipleChunksEquivalent は、同じ入力を分割して複数回呼んでも
// 一括呼び出しと同じ結果になることを検証する（分割耐性の総合テスト）。
func TestIACParser_MultipleChunksEquivalent(t *testing.T) {
	full := []byte{iac, will, 3, 'r', 'o', 'u', 't', 'e', 'r', iac, sb, 24, 1, iac, se, '>', iac, do, 24}
	// 一括。
	cleanFull, respFull := (&iacParser{}).stripIAC(full)

	// 1 バイトずつ分割。
	p := &iacParser{}
	var cleanParts, respParts []byte
	for i := 0; i < len(full); i++ {
		c, r := p.stripIAC(full[i : i+1])
		cleanParts = append(cleanParts, c...)
		respParts = append(respParts, r...)
	}
	if string(cleanFull) != string(cleanParts) {
		t.Errorf("clean mismatch:\n full = %q\n parts = %q", cleanFull, cleanParts)
	}
	if string(respFull) != string(respParts) {
		t.Errorf("resp mismatch:\n full = %v\n parts = %v", respFull, respParts)
	}
}
