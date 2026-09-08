package action

import (
	"bytes"
	"fmt"
	"sync"
)

// LiveLog is a concurrency-safe write buffer used to stream act output
// to the log endpoint while a workflow run is in progress.
type LiveLog struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	done bool
}

func (l *LiveLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n, err := l.buf.Write(p)
	if err != nil {
		return 0, fmt.Errorf("livelog write: %w", err)
	}
	return n, nil
}

func (l *LiveLog) Finish() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.done = true
}

// Read returns the bytes from offset onward and whether the log is complete
// and fully consumed.
func (l *LiveLog) Read(offset int) (chunk []byte, exhausted bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	all := l.buf.Bytes()
	if offset < len(all) {
		chunk = make([]byte, len(all)-offset)
		copy(chunk, all[offset:])
	}
	exhausted = l.done && offset+len(chunk) >= len(all)
	return chunk, exhausted
}

func (l *LiveLog) Bytes() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := make([]byte, l.buf.Len())
	copy(b, l.buf.Bytes())
	return b
}
