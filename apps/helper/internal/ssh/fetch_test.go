package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"

	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/session"
)

// 本ファイルは実機を用意せずに SSH 取得経路（ハンドシェイク → PTY → シェル →
// プロンプト学習 → コマンド実行 → 本文整形）を検証する。擬似 SSH サーバは
// NW 機器を模して「コマンドエコー → 本文 → プロンプト」を返す。

// fakeSSHDevice は擬似 NW 機器（SSH サーバ）。複数回の接続を受け付ける。
type fakeSSHDevice struct {
	t            *testing.T
	listener     net.Listener
	serverConfig *ssh.ServerConfig

	prompt        string
	fetchCommand  string
	pagerSuppress string
	body          string
	// rejectPassword が true なら認証を拒否する（auth_failed の検証用）。
	rejectPassword bool
}

// newFakeSSHDevice は 127.0.0.1 の空きポートで待ち受ける擬似機器を起動する。
func newFakeSSHDevice(t *testing.T, dev *fakeSSHDevice) *fakeSSHDevice {
	t.Helper()

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ホスト鍵の生成に失敗: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("ホスト鍵の変換に失敗: %v", err)
	}

	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if dev.rejectPassword {
				return nil, fmt.Errorf("password rejected")
			}
			if c.User() != "admin" || string(password) != "secret" {
				return nil, fmt.Errorf("invalid credentials")
			}
			return nil, nil
		},
	}
	cfg.AddHostKey(signer)
	dev.serverConfig = cfg
	dev.t = t

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen に失敗: %v", err)
	}
	dev.listener = ln
	t.Cleanup(func() { _ = ln.Close() })

	go dev.serve()
	return dev
}

// addr は接続先のホストとポートを返す。
func (d *fakeSSHDevice) addr() (string, int) {
	tcp := d.listener.Addr().(*net.TCPAddr)
	return tcp.IP.String(), tcp.Port
}

func (d *fakeSSHDevice) serve() {
	for {
		conn, err := d.listener.Accept()
		if err != nil {
			return // テスト終了に伴うクローズ。
		}
		go d.handleConn(conn)
	}
}

func (d *fakeSSHDevice) handleConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()

	sshConn, chans, reqs, err := ssh.NewServerConn(conn, d.serverConfig)
	if err != nil {
		return // 認証拒否のケースはここで終わる。
	}
	defer func() { _ = sshConn.Close() }()
	go ssh.DiscardRequests(reqs)

	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			return
		}
		go d.handleSession(ch, chReqs)
	}
}

// handleSession は pty-req / shell を受け付け、対話シェルを演じる。
func (d *fakeSSHDevice) handleSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer func() { _ = ch.Close() }()
	shellStarted := make(chan struct{})

	go func() {
		for req := range reqs {
			switch req.Type {
			case "pty-req", "shell":
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
				if req.Type == "shell" {
					close(shellStarted)
				}
			default:
				if req.WantReply {
					_ = req.Reply(false, nil)
				}
			}
		}
	}()

	select {
	case <-shellStarted:
	case <-time.After(5 * time.Second):
		return
	}

	// ログイン直後のバナーとプロンプト。
	_, _ = ch.Write([]byte("\r\nAuthorized access only\r\n" + d.prompt))

	// 1 行ずつ読み、機器の応答を返す。
	var line strings.Builder
	buf := make([]byte, 1)
	for {
		n, err := ch.Read(buf)
		if n > 0 {
			b := buf[0]
			if b == '\r' || b == '\n' {
				d.respond(ch, line.String())
				line.Reset()
			} else {
				line.WriteByte(b)
			}
		}
		if err != nil {
			return
		}
	}
}

// respond は受信した 1 行に対する応答を書き込む。
func (d *fakeSSHDevice) respond(ch ssh.Channel, line string) {
	switch {
	case line == "":
		_, _ = ch.Write([]byte("\r\n" + d.prompt))
	case d.pagerSuppress != "" && line == d.pagerSuppress:
		_, _ = ch.Write([]byte(line + "\r\n" + d.prompt))
	case line == d.fetchCommand:
		_, _ = ch.Write([]byte(line + "\r\n" + d.body + "\r\n" + d.prompt))
	default:
		// 実機は受け取ったコマンドをエコーしてからエラー行を返す。
		_, _ = ch.Write([]byte(line + "\r\n% Invalid input detected at '^' marker.\r\n" + d.prompt))
	}
}

// fetchConfig はテスト用の Config を組んで ssh.Fetch を呼ぶ。
func fetchConfig(t *testing.T, dev *fakeSSHDevice, password string) (*session.Result, error) {
	t.Helper()
	host, port := dev.addr()
	cfg := &session.Config{
		Host:           host,
		Port:           port,
		Username:       "admin",
		Password:       password,
		OSHint:         "cisco-ios",
		PagerSuppress:  dev.pagerSuppress,
		FetchCommand:   dev.fetchCommand,
		ConnectTimeout: 3 * time.Second,
		LoginTimeout:   5 * time.Second,
		CommandTimeout: 5 * time.Second,
		TotalTimeout:   15 * time.Second,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return Fetch(ctx, cfg, &Options{
		KnownHostsPath: filepath.Join(t.TempDir(), "known_hosts"),
	})
}

// TestFetch_EndToEnd は擬似 SSH 機器からコンフィグを取得できることを検証する。
func TestFetch_EndToEnd(t *testing.T) {
	dev := newFakeSSHDevice(t, &fakeSSHDevice{
		prompt:        "r1#",
		fetchCommand:  "show running-config",
		pagerSuppress: "terminal length 0",
		body:          "!\nversion 15.2\n!\nhostname r1\n!",
	})

	res, err := fetchConfig(t, dev, "secret")
	if err != nil {
		t.Fatalf("Fetch に失敗: %v", err)
	}
	if res.Prompt != "r1#" {
		t.Errorf("Prompt = %q, want %q", res.Prompt, "r1#")
	}
	if !strings.Contains(res.Body, "hostname r1") {
		t.Errorf("Body にコンフィグが含まれるべき: %q", res.Body)
	}
	if strings.Contains(res.Body, "Authorized access only") {
		t.Errorf("バナーは除去されるべき: %q", res.Body)
	}
	if strings.Contains(res.Body, "terminal length 0") {
		t.Errorf("ページング抑制コマンドのエコーは含まれるべきでない: %q", res.Body)
	}
	if res.ElapsedMs <= 0 {
		t.Errorf("ElapsedMs が設定されるべき: %d", res.ElapsedMs)
	}
}

// TestFetch_AuthFailed は認証失敗が auth_failed になることを検証する。
func TestFetch_AuthFailed(t *testing.T) {
	dev := newFakeSSHDevice(t, &fakeSSHDevice{
		prompt:         "r1#",
		fetchCommand:   "show running-config",
		body:           "hostname r1",
		rejectPassword: true,
	})

	_, err := fetchConfig(t, dev, "wrong")
	if err == nil {
		t.Fatal("認証失敗になるべき")
	}
	se, ok := err.(*session.Error)
	if !ok {
		t.Fatalf("*session.Error を返すべき: %T", err)
	}
	if se.Code != session.CodeAuthFailed {
		t.Errorf("Code = %q, want %q", se.Code, session.CodeAuthFailed)
	}
}

// TestFetch_HostKeyMismatch は記録済みホスト鍵と異なる場合に
// host_key_mismatch で失敗することを検証する（機器交換・MITM の検知）。
func TestFetch_HostKeyMismatch(t *testing.T) {
	knownHosts := filepath.Join(t.TempDir(), "known_hosts")
	dev := newFakeSSHDevice(t, &fakeSSHDevice{
		prompt:       "r1#",
		fetchCommand: "show running-config",
		body:         "hostname r1",
	})
	host, port := dev.addr()
	cfg := &session.Config{
		Host:           host,
		Port:           port,
		Username:       "admin",
		Password:       "secret",
		OSHint:         "cisco-ios",
		FetchCommand:   "show running-config",
		ConnectTimeout: 3 * time.Second,
		LoginTimeout:   5 * time.Second,
		CommandTimeout: 5 * time.Second,
		TotalTimeout:   15 * time.Second,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// 1 回目: 未知のホスト → TOFU で受け入れ、鍵を記録する。
	if _, err := Fetch(ctx, cfg, &Options{KnownHostsPath: knownHosts}); err != nil {
		t.Fatalf("初回取得は成功すべき: %v", err)
	}

	// 記録済みの鍵を別の鍵へ書き換える（機器交換や中間者攻撃で
	// ホスト鍵が変わった状態を再現する）。
	other := testPublicKey(t)
	addr := knownhosts.Normalize(net.JoinHostPort(host, fmt.Sprintf("%d", port)))
	if err := os.WriteFile(knownHosts, []byte(knownhosts.Line([]string{addr}, other)+"\n"), 0o600); err != nil {
		t.Fatalf("known_hosts の書き換えに失敗: %v", err)
	}

	// 2 回目: 記録と異なる鍵 → host_key_mismatch で中断する。
	_, err := Fetch(ctx, cfg, &Options{KnownHostsPath: knownHosts})
	if err == nil {
		t.Fatal("ホスト鍵が変わった場合は失敗すべき")
	}
	se, ok := err.(*session.Error)
	if !ok {
		t.Fatalf("*session.Error を返すべき: %T", err)
	}
	if se.Code != session.CodeHostKeyMismatch {
		t.Errorf("Code = %q, want %q", se.Code, session.CodeHostKeyMismatch)
	}
}

// TestFetch_CommandRejected は機器がコマンドを拒否した場合に
// command_rejected になることを検証する（SSH 経路でも session 側の
// 拒否検出が効くこと）。osHint と実機のコマンド体系が食い違うケース。
func TestFetch_CommandRejected(t *testing.T) {
	dev := newFakeSSHDevice(t, &fakeSSHDevice{
		prompt:       "swx3100#",
		fetchCommand: "show running-config",
		body:         "hostname swx3100",
	})
	host, port := dev.addr()

	// 機器が知らないコマンド（RT 用 "show config"）を送る。
	cfg := &session.Config{
		Host:           host,
		Port:           port,
		Username:       "admin",
		Password:       "secret",
		OSHint:         "yamaha-rt",
		FetchCommand:   "show config",
		ConnectTimeout: 3 * time.Second,
		LoginTimeout:   5 * time.Second,
		CommandTimeout: 5 * time.Second,
		TotalTimeout:   15 * time.Second,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	_, err := Fetch(ctx, cfg, &Options{
		KnownHostsPath: filepath.Join(t.TempDir(), "known_hosts"),
	})
	se, ok := err.(*session.Error)
	if !ok {
		t.Fatalf("*session.Error を返すべき: %T (%v)", err, err)
	}
	if se.Code != session.CodeCommandRejected {
		t.Errorf("Code = %q, want %q (message=%q)", se.Code, session.CodeCommandRejected, se.Message)
	}
}
