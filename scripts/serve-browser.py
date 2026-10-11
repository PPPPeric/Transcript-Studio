"""Read-only static site. This process never imports the legacy transcription API."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class StaticHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.mjs': 'text/javascript'}

    def list_directory(self, path):
        self.send_error(404)
        return None

    def do_GET(self):
        if self.path.split('?', 1)[0] == '/health.json':
            body = b'{"mode":"browser-local","title":"LLJ Transcript Studio"}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            # Browsers abort in-flight asset downloads when a worker is stopped.
            self.close_connection = True

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
                         "worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data: blob:; media-src 'self' blob:; "
                         "connect-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'")
        super().end_headers()


class StaticServer(ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8001)
    options = parser.parse_args()
    dist = Path(__file__).resolve().parents[1] / 'frontend/dist'
    if not (dist / 'index.html').is_file():
        raise SystemExit('请先构建前端')
    server = StaticServer(('127.0.0.1', options.port), partial(StaticHandler, directory=str(dist)))
    print(f'Browser-local site: http://127.0.0.1:{options.port}', flush=True)
    server.serve_forever()
