package telnet

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/session"
)

// 本ファイルは擬似 Telnet 機器（IAC ネゴシエーションを行う TCP サーバ）に対して
// Fetch 全体を通し、IAC 除去ストリーム・対話ログイン・本文整形が噛み合うことを
// 検証する。

// fakeTelnetDevice は擬似 NW 機器（Telnet サーバ）。
type fakeTelnetDevice struct {
	listener net.Listener

	prompt        string
	fetchCommand  string
	pagerSuppress string
	body          string
}

// newFakeTelnetDevice は 127.0.0.1 の空きポートで待ち受ける擬似機器を起動する。
func newFakeTelnetDevice(t *testing.T, dev *fakeTelnetDevice) *fakeTelnetDevice {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen に失敗: %v", err)
	}
	dev.listener = ln
	t.Cleanup(func() { _ = ln.Close() })
	go dev.serve()
	return dev
}

func (d *fakeTelnetDevice) addr() (string, int) {
	tcp := d.listener.Addr().(*net.TCPAddr)
	return tcp.IP.String(), tcp.Port
}

func (d *fakeTelnetDevice) serve() {
	for {
		conn, err := d.listener.Accept()
		if err != nil {
			return
		}
		go d.handleConn(conn)
	}
}

func (d *fakeTelnetDevice) handleConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()

	// 実機同様、接続直後に IAC ネゴシエーション（DO TERMINAL-TYPE / WILL ECHO）を
	// 送り、続けてログインプロンプトを出す。ヘルパー側が IAC を除去できていないと
	// プロンプト検出や本文に制御バイトが混ざる。
	_, _ = conn.Write([]byte{iac, do, 24, iac, will, 1})
	_, _ = conn.Write([]byte("\r\nWelcome\r\n\r\nUsername: "))

	loggedIn := false
	var line strings.Builder
	buf := make([]byte, 1)
	// 実機と同様に、受信バイト列から IAC シーケンスを読み飛ばす
	// （ヘルパーが返す WONT/DONT 応答をコマンド入力と混同しないため）。
	skipper := &iacSkipper{}
	for {
		n, err := conn.Read(buf)
		if n > 0 && skipper.skip(buf[0]) {
			// IAC シーケンスの一部。行バッファへは入れない。
			n = 0
		}
		if n > 0 {
			b := buf[0]
			switch {
			case b == '\r' || b == '\n':
				text := line.String()
				line.Reset()
				if !loggedIn {
					switch text {
					case "admin":
						_, _ = conn.Write([]byte("\r\nPassword: "))
					case "secret":
						loggedIn = true
						// プロンプトの直前にも IAC を挟み、境界処理を確認する。
						_, _ = conn.Write([]byte{iac, will, 3})
						_, _ = conn.Write([]byte("\r\n" + d.prompt))
					default:
						_, _ = conn.Write([]byte("\r\n% Login invalid\r\n\r\nUsername: "))
					}
					continue
				}
				d.respond(conn, text)
			default:
				line.WriteByte(b)
			}
		}
		if err != nil {
			return
		}
	}
}

// iacSkipper は受信バイト列中の IAC シーケンスを読み飛ばす小さな状態機械。
// 本番実装（iacParser）とは独立に書き、テストが実装と共倒れしないようにする。
type iacSkipper struct {
	// state: 0=通常, 1=IAC 受信済, 2=オプションバイト待ち, 3=サブネゴ中, 4=サブネゴ中の IAC
	state int
}

// skip は b が IAC シーケンスの一部なら true を返す。
func (s *iacSkipper) skip(b byte) bool {
	switch s.state {
	case 0:
		if b == iac {
			s.state = 1
			return true
		}
		return false
	case 1:
		switch b {
		case will, wont, do, dont:
			s.state = 2 // 次のオプションバイトも読み飛ばす
		case sb:
			s.state = 3
		case iac:
			s.state = 0 // エスケープされた 0xFF（テストでは使わない）
			return false
		default:
			s.state = 0 // 2 バイトコマンド
		}
		return true
	case 2:
		s.state = 0
		return true
	case 3:
		if b == iac {
			s.state = 4
		}
		return true
	case 4:
		if b == se {
			s.state = 0
		} else {
			s.state = 3
		}
		return true
	}
	return false
}

func (d *fakeTelnetDevice) respond(conn net.Conn, line string) {
	switch {
	case line == "":
		_, _ = conn.Write([]byte("\r\n" + d.prompt))
	case d.pagerSuppress != "" && line == d.pagerSuppress:
		_, _ = conn.Write([]byte(line + "\r\n" + d.prompt))
	case line == d.fetchCommand:
		_, _ = conn.Write([]byte(line + "\r\n" + d.body + "\r\n" + d.prompt))
	default:
		// 実機は受け取ったコマンドをエコーしてからエラー行を返す。
		_, _ = conn.Write([]byte(line + "\r\n% Invalid input detected at '^' marker.\r\n" + d.prompt))
	}
}

// TestFetch_EndToEnd は擬似 Telnet 機器から取得できることを検証する。
func TestFetch_EndToEnd(t *testing.T) {
	dev := newFakeTelnetDevice(t, &fakeTelnetDevice{
		prompt:        "r1#",
		fetchCommand:  "show running-config",
		pagerSuppress: "terminal length 0",
		body:          "!\nversion 15.2\n!\nhostname r1\n!",
	})
	host, port := dev.addr()

	cfg := &session.Config{
		Host:           host,
		Port:           port,
		Username:       "admin",
		Password:       "secret",
		OSHint:         "cisco-ios",
		PagerSuppress:  "terminal length 0",
		FetchCommand:   "show running-config",
		ConnectTimeout: 3 * time.Second,
		LoginTimeout:   5 * time.Second,
		CommandTimeout: 5 * time.Second,
		TotalTimeout:   15 * time.Second,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	res, err := Fetch(ctx, cfg)
	if err != nil {
		t.Fatalf("Fetch に失敗: %v", err)
	}
	if res.Prompt != "r1#" {
		t.Errorf("Prompt = %q, want %q", res.Prompt, "r1#")
	}
	if !strings.Contains(res.Body, "hostname r1") {
		t.Errorf("Body にコンフィグが含まれるべき: %q", res.Body)
	}
	if strings.ContainsRune(res.Body, 0xFF) {
		t.Errorf("IAC バイトが本文に残ってはならない: %q", res.Body)
	}
	if strings.Contains(res.Body, "Welcome") {
		t.Errorf("バナーは除去されるべき: %q", res.Body)
	}
}

// TestFetch_AuthFailed は認証拒否が auth_failed になることを検証する。
func TestFetch_AuthFailed(t *testing.T) {
	dev := newFakeTelnetDevice(t, &fakeTelnetDevice{
		prompt:       "r1#",
		fetchCommand: "show running-config",
		body:         "hostname r1",
	})
	host, port := dev.addr()

	cfg := &session.Config{
		Host:           host,
		Port:           port,
		Username:       "admin",
		Password:       "wrong",
		OSHint:         "cisco-ios",
		FetchCommand:   "show running-config",
		ConnectTimeout: 3 * time.Second,
		LoginTimeout:   3 * time.Second,
		CommandTimeout: 3 * time.Second,
		TotalTimeout:   10 * time.Second,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := Fetch(ctx, cfg)
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

// TestFetch_ConnectFailed は接続できないホストで connect_failed になることを検証する。
func TestFetch_ConnectFailed(t *testing.T) {
	// 空きポートを一度確保してすぐ閉じ、確実に接続を拒否させる。
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen に失敗: %v", err)
	}
	tcp := ln.Addr().(*net.TCPAddr)
	_ = ln.Close()

	cfg := &session.Config{
		Host:           tcp.IP.String(),
		Port:           tcp.Port,
		Username:       "admin",
		Password:       "secret",
		OSHint:         "cisco-ios",
		FetchCommand:   "show running-config",
		ConnectTimeout: 2 * time.Second,
		LoginTimeout:   2 * time.Second,
		CommandTimeout: 2 * time.Second,
		TotalTimeout:   5 * time.Second,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err = Fetch(ctx, cfg)
	se, ok := err.(*session.Error)
	if !ok {
		t.Fatalf("*session.Error を返すべき: %T (%v)", err, err)
	}
	if se.Code != session.CodeConnectFailed {
		t.Errorf("Code = %q, want %q", se.Code, session.CodeConnectFailed)
	}
}
