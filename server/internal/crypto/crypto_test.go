package crypto

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

func TestWebCryptoVectors(t *testing.T) {
	b, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name, Key                           string
		IV, Plaintext, Ciphertext, Envelope []byte
		Metadata                            json.RawMessage
	}
	if err = json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			p, err := Decrypt(v.Key, v.IV, v.Ciphertext)
			if err != nil || !bytes.Equal(p, v.Plaintext) {
				t.Fatalf("WebCrypto decrypt: %v", err)
			}
			m, p, err := Decompress(v.Key, v.Envelope)
			if err != nil || !bytes.Equal(p, v.Plaintext) || !bytes.Equal(m, compact(v.Metadata)) {
				t.Fatalf("decode envelope: %s %v", m, err)
			}
			b, err := Compress(v.Key, m, p)
			if err != nil {
				t.Fatal(err)
			}
			_, p2, err := Decompress(v.Key, b)
			if err != nil || !bytes.Equal(p, p2) {
				t.Fatalf("round trip: %v", err)
			}
			newKey := Key()
			b, err = Reencrypt(v.Key, newKey, v.Envelope)
			if err != nil {
				t.Fatal(err)
			}
			_, p2, err = Decompress(newKey, b)
			if err != nil || !bytes.Equal(p, p2) {
				t.Fatalf("reencrypt: %v", err)
			}
			if _, _, err = Decompress(v.Key, b); err == nil {
				t.Fatal("old key accepted")
			}
			iv, ct, err := Encrypt(v.Key, p)
			if err != nil {
				t.Fatal(err)
			}
			p2, err = Decrypt(v.Key, iv, ct)
			if err != nil || !bytes.Equal(p, p2) {
				t.Fatal("AES round trip")
			}
		})
	}
}
func compact(j []byte) []byte { var b bytes.Buffer; _ = json.Compact(&b, j); return b.Bytes() }
func TestMalformed(t *testing.T) {
	for _, b := range [][]byte{nil, {0, 0, 0, 2}, {0, 0, 0, 1, 255, 255, 255, 255}, {0, 0, 0, 1, 0, 0, 0, 0}} {
		if _, _, err := Decompress(Key(), b); err == nil {
			t.Fatal("accepted malformed envelope")
		}
	}
	if _, err := Decrypt(Key(), nil, nil); err == nil {
		t.Fatal("accepted IV")
	}
}
