package ssh

import (
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// ----- 暗号方式リスト -----

// TestMergeAlgorithms_Legacy はレガシー方式が「実装済みのものだけ」「重複なしで」
// 末尾に追加されることを検証する。
func TestMergeAlgorithms_Legacy(t *testing.T) {
	kex := keyExchanges()
	if !contains(kex, "diffie-hellman-group1-sha1") {
		t.Errorf("旧機器向けの diffie-hellman-group1-sha1 が含まれるべき: %v", kex)
	}
	if kex[0] != ssh.SupportedAlgorithms().KeyExchanges[0] {
		t.Errorf("安全側の方式が先頭に来るべき: %v", kex)
	}

	cs := ciphers()
	if !contains(cs, "aes128-cbc") {
		t.Errorf("aes128-cbc が含まれるべき: %v", cs)
	}
	// x/crypto/ssh は aes192-cbc / aes256-cbc を実装していないため、
	// 許可リストに書いてあっても落とさなければならない（渡すと接続自体が失敗する）。
	if contains(cs, "aes256-cbc") || contains(cs, "aes192-cbc") {
		t.Errorf("未実装の CBC 暗号は除外されるべき: %v", cs)
	}

	ms := macs()
	if countOf(ms, "hmac-sha1") != 1 {
		t.Errorf("hmac-sha1 は既定に含まれるため重複してはならない: %v", ms)
	}

	hk := hostKeyAlgorithms()
	if !contains(hk, "ssh-rsa") {
		t.Errorf("旧機器のホスト鍵形式 ssh-rsa が含まれるべき: %v", hk)
	}
}

func contains(list []string, want string) bool {
	return countOf(list, want) > 0
}

func countOf(list []string, want string) int {
	n := 0
	for _, v := range list {
		if v == want {
			n++
		}
	}
	return n
}

// ----- ホスト鍵検証（TOFU） -----

// testPublicKey は検証用の ed25519 公開鍵を生成する。
func testPublicKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("鍵生成に失敗: %v", err)
	}
	key, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatalf("公開鍵の変換に失敗: %v", err)
	}
	return key
}

// TestHostKeyVerifier_TOFU は「初回受入 → 以降固定」の挙動を検証する。
func TestHostKeyVerifier_TOFU(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	v, err := newHostKeyVerifier(path)
	if err != nil {
		t.Fatalf("newHostKeyVerifier: %v", err)
	}

	keyA := testPublicKey(t)
	remote := &net.TCPAddr{IP: net.ParseIP("192.0.2.10"), Port: 22}

	// 1 回目: 未知のホスト → 受け入れて記録する。
	if err := v.check("192.0.2.10:22", remote, keyA); err != nil {
		t.Fatalf("初回接続は受け入れられるべき: %v", err)
	}
	recorded, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("known_hosts 読み込み: %v", err)
	}
	if !strings.Contains(string(recorded), "192.0.2.10") {
		t.Errorf("known_hosts にホストが記録されるべき: %q", recorded)
	}

	// 2 回目: 同じ鍵 → 受け入れる（行が増えないこと）。
	if err := v.check("192.0.2.10:22", remote, keyA); err != nil {
		t.Fatalf("記録済みの鍵は受け入れられるべき: %v", err)
	}
	again, _ := os.ReadFile(path)
	if len(strings.TrimSpace(string(again))) != len(strings.TrimSpace(string(recorded))) {
		t.Errorf("同一鍵の再接続で行が追加されてはならない: %q", again)
	}

	// 3 回目: 別の鍵 → 拒否し、mismatch を記録する。
	keyB := testPublicKey(t)
	if err := v.check("192.0.2.10:22", remote, keyB); err == nil {
		t.Fatal("鍵が変わった場合は拒否されるべき")
	}
	if v.mismatch == nil {
		t.Error("mismatch が記録されるべき（host_key_mismatch の判定に使う）")
	}
}

// TestHostKeyVerifier_DifferentHosts は別ホストの鍵が干渉しないことを検証する。
func TestHostKeyVerifier_DifferentHosts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	v, err := newHostKeyVerifier(path)
	if err != nil {
		t.Fatalf("newHostKeyVerifier: %v", err)
	}
	keyA := testPublicKey(t)
	keyB := testPublicKey(t)

	if err := v.check("192.0.2.10:22", &net.TCPAddr{IP: net.ParseIP("192.0.2.10"), Port: 22}, keyA); err != nil {
		t.Fatalf("host A の初回接続: %v", err)
	}
	if err := v.check("192.0.2.11:22", &net.TCPAddr{IP: net.ParseIP("192.0.2.11"), Port: 22}, keyB); err != nil {
		t.Fatalf("host B の初回接続も受け入れられるべき: %v", err)
	}
	if v.mismatch != nil {
		t.Errorf("別ホストの鍵は不一致扱いにしてはならない: %v", v.mismatch)
	}
}

// TestDefaultKnownHostsPath_Env は環境変数での上書きを検証する。
func TestDefaultKnownHostsPath_Env(t *testing.T) {
	want := filepath.Join(t.TempDir(), "custom_known_hosts")
	t.Setenv(knownHostsEnv, want)
	got, err := DefaultKnownHostsPath()
	if err != nil {
		t.Fatalf("DefaultKnownHostsPath: %v", err)
	}
	if got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
}

// ----- 期限付き読み取りストリーム -----

// TestStream_ReadDeadline は SSH の io.Reader に読み取り期限を被せられることを
// 検証する（session 側の状態機械が「一定時間読んで照合する」前提で動くため）。
func TestStream_ReadDeadline(t *testing.T) {
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	s := newStream(io.Discard, pr)
	defer s.Close()

	// データが来ない状態で期限を切ると、Timeout() が true のエラーになる。
	_ = s.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	buf := make([]byte, 16)
	if _, err := s.Read(buf); err == nil {
		t.Fatal("期限超過でエラーになるべき")
	} else if ne, ok := err.(net.Error); !ok || !ne.Timeout() {
		t.Fatalf("net.Error(Timeout=true) を返すべき: %#v", err)
	}

	// データが来れば読み取れる。
	go func() { _, _ = pw.Write([]byte("router#")) }()
	_ = s.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := s.Read(buf)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got := string(buf[:n]); got != "router#" {
		t.Errorf("Read = %q, want %q", got, "router#")
	}
}

// TestStream_ReadSplitsLargeChunk は呼び出し側バッファに収まらない分が
// 次回 Read で返る（取りこぼさない）ことを検証する。
func TestStream_ReadSplitsLargeChunk(t *testing.T) {
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	s := newStream(io.Discard, pr)
	defer s.Close()

	go func() { _, _ = pw.Write([]byte("abcdef")) }()
	_ = s.SetReadDeadline(time.Now().Add(2 * time.Second))

	small := make([]byte, 4)
	n, err := s.Read(small)
	if err != nil || string(small[:n]) != "abcd" {
		t.Fatalf("1 回目の Read = %q, err = %v", small[:n], err)
	}
	n, err = s.Read(small)
	if err != nil || string(small[:n]) != "ef" {
		t.Fatalf("2 回目の Read = %q, err = %v", small[:n], err)
	}
}

// TestStream_EOF は相手側が閉じた場合に EOF 系エラーを返し続けることを検証する。
func TestStream_EOF(t *testing.T) {
	pr, pw := io.Pipe()
	s := newStream(io.Discard, pr)
	defer s.Close()

	_ = pw.Close()
	_ = s.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 8)
	if _, err := s.Read(buf); err == nil {
		t.Fatal("EOF エラーになるべき")
	}
	// 2 回目も同じエラーを返す（読み取りループが無限に回らないこと）。
	if _, err := s.Read(buf); err == nil {
		t.Fatal("EOF 後も繰り返しエラーを返すべき")
	}
}
