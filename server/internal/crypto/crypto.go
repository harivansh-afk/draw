// Package crypto implements Excalidraw's WebCrypto and concatBuffers formats.
package crypto

import (
	"bytes"
	"compress/zlib"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

func ID() string    { return hex.EncodeToString(random(10)) }
func Token() string { return base64.RawURLEncoding.EncodeToString(random(32)) }
func Key() string   { return base64.RawURLEncoding.EncodeToString(random(16)) }
func random(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}
func aead(key string) (cipher.AEAD, error) {
	b, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil || len(b) != 16 {
		return nil, errors.New("invalid AES-128 key")
	}
	block, err := aes.NewCipher(b)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func Encrypt(key string, data []byte) (iv, ciphertext []byte, err error) {
	a, err := aead(key)
	if err != nil {
		return nil, nil, err
	}
	iv = random(12)
	return iv, a.Seal(nil, iv, data, nil), nil
}
func Decrypt(key string, iv, ciphertext []byte) ([]byte, error) {
	a, err := aead(key)
	if err != nil {
		return nil, err
	}
	if len(iv) != a.NonceSize() {
		return nil, errors.New("invalid IV")
	}
	return a.Open(nil, iv, ciphertext, nil)
}
func Concat(chunks ...[]byte) []byte {
	b := binary.BigEndian.AppendUint32(nil, 1)
	for _, c := range chunks {
		b = binary.BigEndian.AppendUint32(b, uint32(len(c)))
		b = append(b, c...)
	}
	return b
}
func Split(b []byte, count int) ([][]byte, error) {
	if len(b) < 4 || binary.BigEndian.Uint32(b[:4]) != 1 {
		return nil, errors.New("invalid envelope version")
	}
	b = b[4:]
	chunks := make([][]byte, 0, count)
	for len(b) > 0 {
		if len(b) < 4 || len(chunks) >= count {
			return nil, errors.New("invalid envelope length")
		}
		n := uint64(binary.BigEndian.Uint32(b[:4]))
		b = b[4:]
		if n > uint64(len(b)) {
			return nil, errors.New("truncated envelope")
		}
		chunks = append(chunks, b[:int(n)])
		b = b[int(n):]
	}
	if len(chunks) != count {
		return nil, errors.New("invalid envelope chunks")
	}
	return chunks, nil
}

var encodingMetadata = []byte(`{"version":2,"compression":"pako@1","encryption":"AES-GCM"}`)

func Compress(key string, metadata json.RawMessage, data []byte) ([]byte, error) {
	if len(metadata) == 0 {
		metadata = json.RawMessage("null")
	}
	if !json.Valid(metadata) {
		return nil, errors.New("invalid metadata")
	}
	var b bytes.Buffer
	z := zlib.NewWriter(&b)
	if _, err := z.Write(Concat(metadata, data)); err != nil {
		return nil, err
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	iv, ct, err := Encrypt(key, b.Bytes())
	if err != nil {
		return nil, err
	}
	return Concat(encodingMetadata, iv, ct), nil
}
func outer(key string, b []byte) ([][]byte, []byte, error) {
	c, err := Split(b, 3)
	if err != nil {
		return nil, nil, err
	}
	var m struct {
		Version                 int
		Compression, Encryption string
	}
	if err = json.Unmarshal(c[0], &m); err != nil {
		return nil, nil, err
	}
	if (m.Version != 1 && m.Version != 2) || m.Encryption != "AES-GCM" || (m.Compression != "" && m.Compression != "pako@1") {
		return nil, nil, errors.New("unsupported encoding")
	}
	p, err := Decrypt(key, c[1], c[2])
	return c, p, err
}
func Decompress(key string, b []byte) (metadata json.RawMessage, data []byte, err error) {
	c, p, err := outer(key, b)
	if err != nil {
		return nil, nil, err
	}
	var m struct{ Compression string }
	_ = json.Unmarshal(c[0], &m)
	if m.Compression != "" {
		z, e := zlib.NewReader(bytes.NewReader(p))
		if e != nil {
			return nil, nil, e
		}
		defer z.Close()
		p, e = io.ReadAll(io.LimitReader(z, 64<<20+1))
		if e != nil {
			return nil, nil, e
		}
		if len(p) > 64<<20 {
			return nil, nil, errors.New("inflated data too large")
		}
	}
	inner, err := Split(p, 2)
	if err != nil {
		return nil, nil, err
	}
	if !json.Valid(inner[0]) {
		return nil, nil, fmt.Errorf("invalid metadata JSON")
	}
	return inner[0], inner[1], nil
}
func Reencrypt(oldKey, newKey string, b []byte) ([]byte, error) {
	c, p, err := outer(oldKey, b)
	if err != nil {
		return nil, err
	}
	iv, ct, err := Encrypt(newKey, p)
	if err != nil {
		return nil, err
	}
	return Concat(c[0], iv, ct), nil
}
