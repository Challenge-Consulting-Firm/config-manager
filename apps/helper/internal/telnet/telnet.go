// Package telnet は NW 機器への Telnet 接続を提供する。
//
// 本パッケージの責務は「TCP 接続」と「IAC ネゴシエーションの除去」のみで、
// ログイン以降のコンフィグ取得手順は internal/session が担う。
//
// パスワード類は本パッケージ内でもログ出力・永続化しない。Fetch 完了後は
// 呼び出し側で *session.Config の参照を破棄し、GC に回収させることを前提とする。
//
// 【重要】Telnet は平文プロトコルである。本ヘルパーと機器間の通信は
// 暗号化されず、同一セグメント上のパケットキャプチャで認証情報が漏洩する
// 可能性がある。暗号化が必要な場合は internal/ssh（protocol="ssh"）を使うこと。
// SPA 側の UI でも注意喚起するが、本パッケージ利用者も留意すること。
package telnet

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"time"

	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/session"
)

// Telnet プロトコル定数（RFC 854）。
const (
	iac  = 255 // Interpret As Command
	dont = 254
	do   = 253
	wont = 252
	will = 251
	sb   = 250 // Subnegotiation Begin
	se   = 240 // Subnegotiation End
)

// DefaultPort は Telnet の既定ポート。
const DefaultPort = 23

// Fetch は Telnet でコンフィグ本文を取得する。失敗時は *session.Error を返す。
//
// ctx には全体タイムアウト（TotalTimeout）を設定したコンテキストを渡すこと。
func Fetch(ctx context.Context, cfg *session.Config) (*session.Result, error) {
	start := time.Now()

	// TCP 接続（ConnectTimeout）。
	dialer := &net.Dialer{Timeout: cfg.ConnectTimeout}
	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		// ctx の Deadline 超過なら timeout、それ以外は connect_failed。
		if session.IsContextTimeout(ctx, err) {
			return nil, session.NewError(session.CodeTimeout, "connect timeout", err)
		}
		return nil, session.NewError(session.CodeConnectFailed, "TCP connection failed", err)
	}
	// 接続が確立しても後続でエラーになれば確実に閉じる。
	defer func() { _ = conn.Close() }()

	// IAC を除去するストリームでラップし、共通の取得手順へ渡す。
	// Telnet は認証もプロンプト対話で行うため ModeInteractiveLogin。
	result, err := session.Run(ctx, &iacStream{conn: conn}, cfg, session.ModeInteractiveLogin)
	if err != nil {
		return nil, err
	}
	result.ElapsedMs = time.Since(start).Milliseconds()
	return result, nil
}

// iacStream は net.Conn を「IAC 除去済みのストリーム」として見せる session.Stream 実装。
//
// Read のたびに IAC シーケンスを取り除き、ネゴシエーション要求には消極応答
// （WONT/DONT）を conn へ直接書き戻す。IAC のみのチャンクでは (0, nil) を返す
// ことがあるが、session 側の読み取りループは期限まで読み続けるため問題ない。
type iacStream struct {
	conn   net.Conn
	parser iacParser
	// scratch は conn からの生読み取り用バッファ。Read の要求長に応じて伸ばして
	// 再利用する。
	scratch []byte
	// rest は p に収まらなかった除去済みバイト。IAC 除去後の長さは生バイト長を
	// 超えないため通常は空だが、pending の結合によって溢れる可能性を潰しておく。
	rest []byte
}

func (s *iacStream) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	// 前回の残りを先に返す。
	if len(s.rest) > 0 {
		n := copy(p, s.rest)
		s.rest = s.rest[n:]
		return n, nil
	}
	if len(s.scratch) < len(p) {
		s.scratch = make([]byte, len(p))
	}
	nr, err := s.conn.Read(s.scratch[:len(p)])
	if nr > 0 {
		clean, resp := s.parser.stripIAC(s.scratch[:nr])
		if len(resp) > 0 {
			_, _ = s.conn.Write(resp)
		}
		n := copy(p, clean)
		if n < len(clean) {
			// clean は stripIAC が新規に確保したバッファなので、そのまま保持できる。
			s.rest = clean[n:]
		}
		return n, err
	}
	return 0, err
}

func (s *iacStream) Write(p []byte) (int, error) { return s.conn.Write(p) }

func (s *iacStream) SetReadDeadline(t time.Time) error { return s.conn.SetReadDeadline(t) }

// iacParser は Telnet IAC ネゴシエーションのストリームパーサー。
// Telnet は TCP ストリーム上のプロトコルであり、IAC シーケンスが
// Read チャンク境界をまたぐ場合がある（例: IAC が前チャンク末尾、DO が次チャンク先頭）。
// 本構造体は未処理の末尾バイトを pending に退避し、次回呼び出し時に先頭へ結合して
// 解釈する。接続（Fetch 呼び出し）毎に新規生成すること。
type iacParser struct {
	// pending は前回チャンクの末尾にあった未確定バイト（不完全な IAC シーケンス）。
	// 次回 stripIAC 呼び出し時に新しい入力の先頭へ結合される。
	pending []byte
	// inSubneg は IAC SB 開始後・IAC SE 終了前の状態か。
	inSubneg bool
}

// stripIAC はバイト列から IAC 制御シーケンスを取り除き、プレーンテキスト部を返す。
// 同時に、ネゴシエーション要求（DO/WILL 等）には消極応答（WONT/DONT）を返す。
//
// チャンク境界をまたぐ IAC シーケンス（IAC 単独、IAC DO/WILL の途中、
// IAC SB ... IAC SE の途中）は pending へ退避し、次回呼び出しで解釈を完了する。
//
// 戻り値: (クリーンアップ済みバイト列, 送信すべき応答バイト列)
func (p *iacParser) stripIAC(raw []byte) ([]byte, []byte) {
	// 前回の未確定バイトを先頭へ結合。
	if len(p.pending) > 0 {
		raw = append(p.pending, raw...)
		p.pending = p.pending[:0] // 下限を戻して再利用（capacity は維持）
	}

	var out bytes.Buffer
	var resp bytes.Buffer
	n := len(raw)
	i := 0
	for i < n {
		// サブネゴシエーション中は IAC SE が来るまで全バイトをスキップ。
		// IAC がチャンク末尾で途切れる場合は pending へ退避し、次回 IAC SE を補完する。
		if p.inSubneg {
			if raw[i] == iac {
				if i+1 < n {
					if raw[i+1] == se {
						p.inSubneg = false
						i += 2
						continue
					}
					if raw[i+1] == iac {
						// SB 内のエスケープされた 0xFF。スキップ。
						i += 2
						continue
					}
				}
				// IAC の次が未確定（チャンク末尾）。次回へ退避して中断。
				p.pending = append(p.pending, raw[i:]...)
				i = n
				continue
			}
			i++
			continue
		}

		b := raw[i]
		if b != iac {
			out.WriteByte(b)
			i++
			continue
		}

		// IAC シーケンス処理。末尾で途切れている場合は pending へ退避。
		if i+1 >= n {
			// IAC 単独（不完全）。次回へ退避。
			p.pending = append(p.pending, raw[i])
			break
		}
		cmd := raw[i+1]
		switch cmd {
		case do:
			// DO X → WONT X（受け入れない）。3 バイト揃っている必要がある。
			if i+2 < n {
				resp.Write([]byte{iac, wont, raw[i+2]})
				i += 3
			} else {
				// IAC DO の途中。次回へ退避。
				p.pending = append(p.pending, raw[i], raw[i+1])
				i = n
			}
		case dont:
			// DONT X → 応答不要。3 バイト必要。
			if i+2 < n {
				i += 3
			} else {
				p.pending = append(p.pending, raw[i], raw[i+1])
				i = n
			}
		case will:
			// WILL X → DONT X。3 バイト必要。
			if i+2 < n {
				resp.Write([]byte{iac, dont, raw[i+2]})
				i += 3
			} else {
				p.pending = append(p.pending, raw[i], raw[i+1])
				i = n
			}
		case wont:
			// WONT X → 応答不要。3 バイト必要。
			if i+2 < n {
				i += 3
			} else {
				p.pending = append(p.pending, raw[i], raw[i+1])
				i = n
			}
		case sb:
			// Subnegotiation 開始: IAC SB ... IAC SE。
			p.inSubneg = true
			i += 2
		case iac:
			// IAC IAC = エスケープされた 0xFF
			out.WriteByte(0xFF)
			i += 2
		default:
			// その他の 2 バイトコマンド（AYT, NOP 等）はスキップ。
			i += 2
		}
	}
	return out.Bytes(), resp.Bytes()
}
