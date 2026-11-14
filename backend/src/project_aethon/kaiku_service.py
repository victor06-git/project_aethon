"""Kaiku HTTP service: the whole Python coach behind one endpoint.

    POST /kaiku/messages  {"question": "..."}  ->  a coach Answer (docs/API.md), extended with
                                                   `sources`, `dataUsed`, `trace` and `noEvidence`
    GET  /kaiku/health                         ->  {"ok": true, "model": "...", "data": "..."}

The Node backend calls this through backend/src/infrastructure/llm/kaikuCoach.ts when
REVI_KAIKU_URL is set. Any error here (keys missing, quota, crash) returns {"message": ...}
with status 5xx and the app falls back to its local answers, so the screen keeps working.

Run from the backend/ folder:

    uv run python -m project_aethon.kaiku_service
    # or, without uv:  cd src && python -m project_aethon.kaiku_service

Settings (environment, all optional):
    KAIKU_PORT      port to listen on (default 8765)
    KAIKU_MODEL     Gemini model (default: kaiku_agent.MODEL_NAME)
    KAIKU_THINKING  thinking level of the answer step (minimal, low, ...)
    KAIKU_DATASET   path to a transactions CSV (default: the synthetic sample)
"""
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .kaiku_agent import MODEL_NAME, Kaiku, Result, create_agent, load_transactions

_lock = threading.Lock()
_agent: Kaiku | None = None


def settings() -> dict:
    return {
        "port": int(os.environ.get("KAIKU_PORT", "8765")),
        "model": os.environ.get("KAIKU_MODEL") or MODEL_NAME,
        "thinking": os.environ.get("KAIKU_THINKING"),
        "dataset": os.environ.get("KAIKU_DATASET") or None,
    }


def get_agent() -> Kaiku:
    """One shared agent (its caches make repeated demo questions free)."""
    global _agent
    with _lock:
        if _agent is None:
            s = settings()
            kwargs = {"model_name": s["model"], "transactions": load_transactions(s["dataset"])}
            if s["thinking"]:  # one level for both steps (some models reject "minimal")
                kwargs["router_thinking"] = kwargs["answer_thinking"] = s["thinking"]
            _agent = create_agent(**kwargs)
        return _agent


# ---------------------------------------------------------------------------
# Result -> Answer (the shape the screen renders; see docs/API.md)
# ---------------------------------------------------------------------------
def _clean(text: str) -> str:
    """Screen text: [WEB n] -> [n]; [DATA]/[MODEL] disappear (the sources block carries them)."""
    text = re.sub(r"\s*\[WEB\s*(\d+)\]", r" [\1]", text)
    text = re.sub(r"\s*\[(?:DATA|MODEL)\]", "", text)
    text = re.sub(r"[ \t]+([.,;:!?])", r"\1", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def to_answer(res: Result) -> dict:
    by_n = {s["n"]: s for s in res.sources}
    sources = [{
        "k": c["k"],
        "official": by_n[c["n"]]["official"],
        "domain": by_n[c["n"]]["domain"],
        "title": by_n[c["n"]]["title"],
        "url": by_n[c["n"]]["url"],
        "published": by_n[c["n"]]["published"] or None,
        "fragment": c["fragment"],
    } for c in res.cited]

    answer: dict = {"type": "clarify" if res.route == "clarify" else "fact", "text": _clean(res.text), "source": "model"}
    if res.document:
        lines = res.answer.splitlines()
        subject, body = "Letter", res.answer
        if lines and lines[0].lower().startswith("subject:"):
            subject = lines[0].split(":", 1)[1].strip()
            body = "\n".join(lines[1:]).strip()
        answer.update(type="action", letter={"subject": subject, "body": body},
                      text="Here is a draft built from the sources below. Review the [bracketed] details; nothing is sent without you.")
    if sources:
        answer["sources"] = sources
    if res.data is not None and "error" not in res.data:
        s = settings()
        answer["dataUsed"] = {"period": res.data.get("period", ""), "transactions": res.data.get("transactions", 0),
                              "note": os.path.basename(s["dataset"]) if s["dataset"] else "synthetic sample transactions"}
    if res.no_evidence:
        answer["noEvidence"] = True
        answer["text"] = _clean(res.answer)
    checks = res.checks or {}
    answer["trace"] = {
        "route": res.route + (" (document)" if res.document else ""),
        "decidedBy": res.decided_by,
        "llmCalls": res.llm_calls,
        "tokens": res.total_tokens,
        "thinkingTokens": res.tokens.get("reasoning", 0),
        "seconds": res.total_seconds,
        "exaCost": round(res.exa_cost, 3),
        "cached": res.cached,
        "query": res.query,
        "thinkingLevel": res.thinking,
        "problems": checks.get("labels", []),
    }
    return answer


def handle_question(question: str) -> tuple[int, dict]:
    question = str(question or "").strip()
    if not question:
        return 400, {"message": "Empty question"}
    if len(question) > 500:
        return 400, {"message": "Question is too long"}
    t0 = time.perf_counter()
    try:
        res = get_agent().ask(question)
    except Exception as e:  # noqa: BLE001 - the Node side falls back to local answers
        msg = f"{type(e).__name__}: {e}"
        if "RESOURCE_EXHAUSTED" in msg or "429" in msg:
            return 503, {"message": "Gemini daily quota exhausted for this model; the app will answer locally."}
        if "API key" in msg or "API_KEY" in msg:
            return 503, {"message": "GEMINI_API_KEY / EXA_API_KEY missing: put them in .env and restart the service."}
        return 500, {"message": msg[:300]}
    print(f"[kaiku] {res.route:<8} {res.llm_calls} calls  {res.total_tokens:>5} tok  "
          f"{time.perf_counter() - t0:5.1f}s  {question[:60]!r}")
    return 200, to_answer(res)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, obj: dict) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")  # direct browser calls during development
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args) -> None:  # route logging is done in handle_question
        pass

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/kaiku/health":
            s = settings()
            self._send(200, {"ok": True, "model": s["model"],
                             "data": s["dataset"] or "synthetic sample", "thinking": s["thinking"]})
        else:
            self._send(404, {"message": "Not found"})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/kaiku/messages":
            return self._send(404, {"message": "Not found"})
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 100_000)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            return self._send(400, {"message": "Bad JSON"})
        status, obj = handle_question(body.get("question"))
        self._send(status, obj)


def main() -> None:
    s = settings()
    server = ThreadingHTTPServer(("127.0.0.1", s["port"]), Handler)
    print(f"Kaiku service: http://localhost:{s['port']}/kaiku/messages")
    print(f"  model {s['model']} | thinking {s['thinking'] or 'default'} | "
          f"data {s['dataset'] or 'synthetic sample'}")
    print("  point the app at it with REVI_KAIKU_URL=http://localhost:" + str(s["port"]))
    server.serve_forever()


if __name__ == "__main__":
    main()
