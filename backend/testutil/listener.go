package testutil

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sync"
)

type MemListener struct {
	conns     chan net.Conn
	closed    chan struct{}
	closeOnce sync.Once
}

func NewMemListener() *MemListener {
	return &MemListener{
		conns:  make(chan net.Conn),
		closed: make(chan struct{}),
	}
}

func (l *MemListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *MemListener) Close() error {
	l.closeOnce.Do(func() {
		close(l.closed)
	})
	return nil
}

func (l *MemListener) Addr() net.Addr {
	return &pipeAddr{}
}

func (l *MemListener) DialContext(ctx context.Context, _, _ string) (net.Conn, error) {
	serverConn, clientConn := net.Pipe()
	select {
	case l.conns <- serverConn:
		return clientConn, nil
	case <-l.closed:
		_ = serverConn.Close()
		_ = clientConn.Close()
		return nil, net.ErrClosed
	case <-ctx.Done():
		_ = serverConn.Close()
		_ = clientConn.Close()
		return nil, fmt.Errorf("dial: %w", ctx.Err())
	}
}

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "pipe" }

// type asserts
var _ net.Listener = (*MemListener)(nil)
var _ = http.Transport{
	DialContext: ((*MemListener)(nil)).DialContext,
}
