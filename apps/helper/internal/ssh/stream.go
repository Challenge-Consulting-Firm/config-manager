package ssh

import (
	"io"
	"time"
)

// stream は SSH シェルセッションの stdin/stdout を session.Stream
// （SetReadDeadline を持つストリーム）へ適合させる。
//
// net.Conn と異なり SSH の stdout（io.Reader）には読み取り期限が無く、
// Read はデータが来るまでブロックし続ける。session 側の状態機械は
// 「一定時間読んでからバッファをパターン照合する」前提で書かれているため、
// 専用の goroutine で読み出して channel へ渡し、Read 側でタイマーと select
// することで期限付き読み取りを実現する。
type stream struct {
	w    io.Writer
	ch   <-chan chunk
	done chan struct{}

	// rest は前回の Read で呼び出し側バッファに収まらなかった残り。
	rest []byte
	// err は pump が観測した終端エラー（EOF 等）。以降の Read で返し続ける。
	err error
	// deadline は次回以降の Read の期限。ゼロ値なら無期限。
	deadline time.Time
}

// chunk は pump goroutine から Read へ渡す読み取り結果。
type chunk struct {
	data []byte
	err  error
}

// pumpBuffer は pump goroutine の 1 回の読み取りサイズ。
const pumpBuffer = 4096

// newStream は stdin/stdout を包んだ stream を返し、読み取り goroutine を開始する。
// 利用終了後は必ず Close を呼ぶこと（goroutine を確実に終了させるため）。
func newStream(w io.Writer, r io.Reader) *stream {
	// 送信側がブロックしにくいよう小さめのバッファを持たせる。
	ch := make(chan chunk, 16)
	done := make(chan struct{})
	s := &stream{w: w, ch: ch, done: done}
	go pump(r, ch, done)
	return s
}

// pump は r を読み続けて ch へ流す。done が閉じられたら終了する。
func pump(r io.Reader, ch chan<- chunk, done <-chan struct{}) {
	defer close(ch)
	buf := make([]byte, pumpBuffer)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			// buf は次の Read で上書きされるため、channel へはコピーを渡す。
			b := make([]byte, n)
			copy(b, buf[:n])
			select {
			case ch <- chunk{data: b}:
			case <-done:
				return
			}
		}
		if err != nil {
			select {
			case ch <- chunk{err: err}:
			case <-done:
			}
			return
		}
	}
}

func (s *stream) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	// 前回の残りを先に返す。
	if len(s.rest) > 0 {
		n := copy(p, s.rest)
		s.rest = s.rest[n:]
		return n, nil
	}
	if s.err != nil {
		return 0, s.err
	}

	var timer *time.Timer
	var expired <-chan time.Time
	if !s.deadline.IsZero() {
		remaining := time.Until(s.deadline)
		if remaining <= 0 {
			return 0, errReadTimeout
		}
		timer = time.NewTimer(remaining)
		defer timer.Stop()
		expired = timer.C
	}

	select {
	case c, ok := <-s.ch:
		if !ok {
			// pump が終了して channel が閉じた（通常はエラー chunk が先に届く）。
			s.err = io.EOF
			return 0, s.err
		}
		if c.err != nil {
			s.err = c.err
			return 0, s.err
		}
		n := copy(p, c.data)
		if n < len(c.data) {
			s.rest = c.data[n:]
		}
		return n, nil
	case <-expired:
		return 0, errReadTimeout
	}
}

func (s *stream) Write(p []byte) (int, error) { return s.w.Write(p) }

// SetReadDeadline は以降の Read の期限を設定する（net.Conn と同じ意味）。
func (s *stream) SetReadDeadline(t time.Time) error {
	s.deadline = t
	return nil
}

// Close は pump goroutine を終了させる。SSH セッション自体のクローズは
// 呼び出し側（Fetch）が行う。
func (s *stream) Close() {
	select {
	case <-s.done:
		// 既に閉じている。
	default:
		close(s.done)
	}
}

// errReadTimeout は読み取り期限超過。session 側の isTimeout（net.Error の
// Timeout() 判定）に合致させるため、net.Error を満たす型で返す。
var errReadTimeout error = timeoutError{}

type timeoutError struct{}

func (timeoutError) Error() string   { return "ssh: read deadline exceeded" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
