package helperidentity

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreatePersistsIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.json")
	first, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("LoadOrCreate(first): %v", err)
	}
	second, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("LoadOrCreate(second): %v", err)
	}
	if first.ID() != second.ID() || first.PublicKey() != second.PublicKey() || first.PairingCode() != second.PairingCode() {
		t.Fatal("identity changed after reload")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat identity: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("identity mode = %o, want 600", info.Mode().Perm())
	}
}

func TestProofAndSignatureAreBoundToInputs(t *testing.T) {
	identity, err := GenerateEphemeral()
	if err != nil {
		t.Fatal(err)
	}
	if identity.PairingProof("nonce-a") == identity.PairingProof("nonce-b") {
		t.Fatal("pairing proof is not bound to nonce")
	}
	if identity.SignRedeem("token", "192.0.2.1") == identity.SignRedeem("token", "192.0.2.2") {
		t.Fatal("redeem signature is not bound to target")
	}
	if identity.ID() == "" || identity.PublicKey() == "" || identity.PairingCode() == "" {
		t.Fatal("identity contains an empty public value")
	}
}
