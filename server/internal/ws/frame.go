package ws

import (
	"encoding/binary"
	"encoding/json"
	"errors"
)

type Message struct {
	Event string
	Args  []any
}
type header struct {
	Event  string            `json:"e"`
	Args   []json.RawMessage `json:"a"`
	Binary []int             `json:"b,omitempty"`
}

func Encode(event string, args ...any) []byte {
	if args == nil {
		args = []any{}
	}
	a := make([]any, len(args))
	bins := [][]byte{}
	lengths := []int{}
	for i, v := range args {
		if b, ok := v.([]byte); ok {
			a[i] = map[string]int{"$b": len(bins)}
			bins = append(bins, b)
			lengths = append(lengths, len(b))
		} else {
			a[i] = v
		}
	}
	h, _ := json.Marshal(struct {
		Event  string `json:"e"`
		Args   []any  `json:"a"`
		Binary []int  `json:"b,omitempty"`
	}{event, a, lengths})
	size := 5 + len(h)
	for _, b := range bins {
		size += len(b)
	}
	out := make([]byte, 1, size)
	out[0] = 1
	out = binary.BigEndian.AppendUint32(out, uint32(len(h)))
	out = append(out, h...)
	for _, b := range bins {
		out = append(out, b...)
	}
	return out
}
func Decode(frame []byte) (Message, error) {
	bad := errors.New("bad message")
	if len(frame) < 5 || frame[0] != 1 {
		return Message{}, bad
	}
	n := uint64(binary.BigEndian.Uint32(frame[1:5]))
	if n > uint64(len(frame)-5) || n > 65536 {
		return Message{}, bad
	}
	var h header
	if json.Unmarshal(frame[5:5+int(n)], &h) != nil || h.Event == "" || h.Args == nil {
		return Message{}, bad
	}
	b := frame[5+int(n):]
	bins := [][]byte{}
	for _, length := range h.Binary {
		if length < 0 || length > len(b) {
			return Message{}, bad
		}
		bins = append(bins, b[:length])
		b = b[length:]
	}
	if len(b) != 0 {
		return Message{}, bad
	}
	args := []any{}
	for _, raw := range h.Args {
		var v any
		if json.Unmarshal(raw, &v) != nil {
			return Message{}, bad
		}
		if m, ok := v.(map[string]any); ok {
			if index, exists := m["$b"]; exists {
				f, ok := index.(float64)
				if !ok || len(m) != 1 || f < 0 || f >= float64(len(bins)) || f != float64(int(f)) {
					return Message{}, bad
				}
				v = bins[int(f)]
			}
		}
		args = append(args, v)
	}
	return Message{h.Event, args}, nil
}
