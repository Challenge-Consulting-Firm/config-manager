// Command helper は NW 機器から Telnet でコンフィグを自動取得する
// ローカルヘルパーアプリ（ポータブル型）のエントリポイント。
//
// 2 つのモードを持つ:
//  1. サーバモード（既定）: 127.0.0.1 に HTTP サーバを開き、SPA からの要求を待つ
//  2. CLI モード（fetch サブコマンド）: HTTP サーバを起動せず Telnet 取得を直接実行
//
// セキュリティ:
//   - バインドは 127.0.0.1 のみ（0.0.0.0 禁止）
//   - Origin allowlist による CORS 制限
//   - パスワード類はログ/ファイルへ出さない
//   - Telnet は平文プロトコル（詳細は README のセキュリティ注意）
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"time"

	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/commands"
	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/server"
	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/telnet"
)

func main() {
	log.SetFlags(log.LstdFlags)
	log.SetOutput(os.Stderr)

	// サブコマンド解析。
	if len(os.Args) > 1 && os.Args[1] == "fetch" {
		runCLIFetch(os.Args[2:])
		return
	}

	runServer(os.Args[1:])
}

// runServer は HTTP サーバを起動する。
// 起動引数で許可 Origin を追加指定できる（例: --allow-origin https://staging.fly.dev）。
func runServer(args []string) {
	fs := flag.NewFlagSet("server", flag.ExitOnError)
	var allowOrigins multiFlag
	fs.Var(&allowOrigins, "allow-origin", "許可する Origin を追加（複数指定可・本番 SPA の URL）")
	_ = fs.Parse(args)

	origins := server.DefaultAllowedOrigins()
	origins = append(origins, allowOrigins...)

	srv := server.New(server.Config{
		AllowedOrigins: origins,
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	port, err := srv.Listen(ctx)
	if err != nil {
		log.Fatalf("サーバ起動失敗: %v", err)
	}

	// 起動メッセージ（日本語・プロジェクトルール準拠）。
	fmt.Println("========================================================")
	fmt.Println("  config-manager ヘルパー を起動しました")
	fmt.Println("========================================================")
	fmt.Printf("  待ち受けポート: %d (127.0.0.1)\n", port)
	fmt.Printf("  バージョン    : %s\n", server.Version)
	fmt.Println("  停止方法      : Ctrl+C または SPA の「停止」ボタン")
	fmt.Println("--------------------------------------------------------")
	fmt.Println("  許可 Origin:")
	for _, o := range origins {
		fmt.Printf("    - %s\n", o)
	}
	fmt.Println("--------------------------------------------------------")
	fmt.Println("  【セキュリティ注意】")
	fmt.Println("  ・本ヘルパーは 127.0.0.1 のみで待ち受けます（外部公開なし）")
	fmt.Println("  ・許可された Origin 以外からの要求は拒否します")
	fmt.Println("  ・Telnet は平文プロトコルです。機器との通信は暗号化されません")
	fmt.Println("========================================================")
	fmt.Println()
	fmt.Println("SPA 側でこのヘルパーを検出したら、取得ボタンが有効になります。")
	fmt.Println("終了する場合は Ctrl+C を押すか、SPA の停止ボタンを押してください。")
	fmt.Println()

	if err := srv.Wait(ctx); err != nil {
		log.Printf("シャットダウン完了: %v", err)
	}
	log.Println("ヘルパーを終了します。")
}

// multiFlag は複数回指定可能なフラグ（--allow-origin A --allow-origin B）。
type multiFlag []string

func (m *multiFlag) String() string     { return "" }
func (m *multiFlag) Set(s string) error { *m = append(*m, s); return nil }

// runCLIFetch は CLI デバッグモードで Telnet 取得を直接実行する。
//
// パスワードはコマンドライン引数には乗せない（プロセス一覧で漏洩するため）。
// 標準入力または環境変数から読み込む。
//
// 使い方:
//
//	helper fetch --host 192.168.1.1 --os cisco-ios --username admin
//	（パスワードは HELPER_PASSWORD / HELPER_ENABLE_PASSWORD 環境変数、
//	 または未設定時は標準入力からプロンプトで読み込む）
func runCLIFetch(args []string) {
	fs := flag.NewFlagSet("fetch", flag.ExitOnError)
	host := fs.String("host", "", "接続先ホスト（IP またはホスト名）")
	port := fs.Int("port", 23, "Telnet ポート")
	osHint := fs.String("os", "cisco-ios", "機種ヒント (cisco-ios | yamaha-rt | yamaha-swx | generic)")
	username := fs.String("username", "", "ログインユーザー名")
	commandOverride := fs.String("command", "", "コンフィグ取得コマンドの上書き（任意）")
	_ = fs.Parse(args)

	if *host == "" {
		fmt.Fprintln(os.Stderr, "--host は必須です")
		os.Exit(2)
	}
	if *username == "" {
		fmt.Fprintln(os.Stderr, "--username は必須です")
		os.Exit(2)
	}
	if !commands.Valid(*osHint) {
		fmt.Fprintf(os.Stderr, "--os は cisco-ios | yamaha-rt | yamaha-swx | generic のいずれかです\n")
		os.Exit(2)
	}

	// パスワード取得: 環境変数 → 標準入力。
	password := os.Getenv("HELPER_PASSWORD")
	if password == "" {
		fmt.Print("Password: ")
		reader := bufio.NewReader(os.Stdin)
		line, err := reader.ReadString('\n')
		if err != nil {
			fmt.Fprintf(os.Stderr, "パスワード読み込み失敗: %v\n", err)
			os.Exit(1)
		}
		password = trimNewline(line)
	}

	// enable パスワード（任意）。
	enablePassword := os.Getenv("HELPER_ENABLE_PASSWORD")

	// コマンド解決。
	cmdSet := commands.Lookup(*osHint)
	fetchCmd := cmdSet.Fetch
	if *commandOverride != "" {
		fetchCmd = *commandOverride
	}
	if fetchCmd == "" {
		fmt.Fprintln(os.Stderr, "generic の場合は --command で取得コマンドを指定してください")
		os.Exit(2)
	}

	tcfg := &telnet.Config{
		Host:            *host,
		Port:            *port,
		Username:        *username,
		Password:        password,
		EnablePassword:  enablePassword,
		OSHint:          *osHint,
		CommandOverride: *commandOverride,
		PagerSuppress:   cmdSet.PagerSuppress,
		FetchCommand:    fetchCmd,
		ConnectTimeout:  10 * time.Second,
		LoginTimeout:    15 * time.Second,
		CommandTimeout:  120 * time.Second,
		TotalTimeout:    180 * time.Second,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	result, err := telnet.Fetch(ctx, tcfg)
	if err != nil {
		var te *telnet.Error
		if asTelnetErr(err, &te) {
			fmt.Fprintf(os.Stderr, "取得失敗 [%s]: %s\n", te.Code, te.Message)
		} else {
			fmt.Fprintf(os.Stderr, "取得失敗: %v\n", err)
		}
		os.Exit(1)
	}

	fmt.Printf("=== 取得成功 ===\n")
	fmt.Printf("elapsedMs      : %d\n", result.ElapsedMs)
	fmt.Printf("prompt         : %s\n", result.Prompt)
	fmt.Printf("command        : %s\n", result.Command)
	fmt.Printf("sourceEncoding : %s\n", result.SourceEncoding)
	fmt.Printf("--- body ---\n")
	fmt.Println(result.Body)
}

// asTelnetErr は telnet.Error への型アサーション（errors.As のラップ）。
// errors パッケージを都度 import しないための小さなヘルパ。
func asTelnetErr(err error, target **telnet.Error) bool {
	if te, ok := err.(*telnet.Error); ok {
		*target = te
		return true
	}
	return false
}

// trimNewline は末尾の改行を取り除く。
func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
