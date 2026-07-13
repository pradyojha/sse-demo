# Server-Sent Events (SSE) — Complete Notes

*A reference guide covering fundamentals, working example code, and Azure microservices deployment considerations.*

---

## 1. What Problem Does SSE Solve?

Normally, a client (browser/app) asks the server a question, gets one answer, and the connection ends. That's fine for "get me the weather" but bad for "tell me every time the price changes."

SSE lets the **server keep pushing new data down to the client over one long-lived HTTP connection**, without the client repeatedly asking. Think of it like subscribing to a live radio broadcast instead of calling the radio station every minute to ask "what's playing now?"

### Key Characteristics

| Feature | SSE |
|---|---|
| Direction | One-way: server → client only |
| Protocol | Plain HTTP (no special protocol like WebSocket) |
| Content-Type | `text/event-stream` |
| Reconnection | Built into the browser's `EventSource` API automatically |
| Data format | Simple text, `data: ...` lines |
| Browser API | `EventSource` (native, no library needed) |

**Compare with WebSockets:** WebSockets are **two-way** (client can also send data continuously) and need a protocol upgrade. SSE is simpler — it's "just HTTP that never closes" — which is exactly why it's a great fit when you only need server→client pushes (notifications, live scores, stock tickers, progress bars, log streams).

### How It Works, Step by Step

1. Client opens a normal HTTP GET request (via `EventSource` in the browser, or any HTTP client).
2. Server responds with headers saying "this is a stream": `Content-Type: text/event-stream`, and keeps the connection open — it never sends a "Content-Length" and never closes the response.
3. Server writes small text chunks to the same open response, each formatted like:
   ```
   data: {"price": 105.2}

   ```
   (a blank line marks the end of one "event")
4. The client's `EventSource` fires an `onmessage` event each time a chunk arrives — no polling.
5. If the connection drops, the browser automatically reconnects and can resume using a `Last-Event-ID` header, so you don't lose events.

---

## 2. Example Code — Step-by-Step Setup

### Server Setup (Node.js + Express)

```bash
mkdir sse-demo && cd sse-demo
npm init -y
npm install express
```

**`server.js`:**
```javascript
const express = require('express');
const app = express();

app.use(express.static('public')); // serves index.html below

app.get('/events', (req, res) => {
  // 1. Tell the client this is a stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // 2. Push an event every 2 seconds
  let counter = 0;
  const interval = setInterval(() => {
    counter++;
    const payload = { time: new Date().toISOString(), counter };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }, 2000);

  // 3. Send a comment line every 20s as a heartbeat (prevents proxies/LBs from
  //    thinking the connection is idle and closing it)
  const heartbeat = setInterval(() => res.write(':\n\n'), 20000);

  // 4. Clean up when client disconnects
  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
```

### Client Setup (plain HTML/JS)

**`public/index.html`:**
```html
<!DOCTYPE html>
<html>
<body>
  <ul id="log"></ul>
  <script>
    const source = new EventSource('/events');

    source.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const li = document.createElement('li');
      li.textContent = `#${data.counter} at ${data.time}`;
      document.getElementById('log').appendChild(li);
    };

    source.onerror = () => {
      console.log('Connection lost — browser will auto-reconnect');
    };
  </script>
</body>
</html>
```

### Run It

```bash
node server.js
# open http://localhost:3000 in a browser — watch the list update every 2s
```

That's the entire mechanism — no WebSocket library, no socket.io, nothing exotic. Any backend language works the same way: Python (`text/event-stream` + generator), Java (Spring's `SseEmitter`), .NET (`Response.Body` streaming), Go, etc. — the contract is identical: keep the connection open, keep writing `data: ...\n\n` chunks.

---

## 3. Code Walkthrough — Server vs. Client Responsibilities

### Step 1 — Client Initiates the Connection

```javascript
const source = new EventSource('/events');
```

This is the client's only "request." `EventSource` is a browser-native object built specifically for SSE — it does a plain HTTP GET to `/events`, but internally it knows to interpret the response as an ongoing stream rather than a one-shot payload. No polling loop needed; the browser handles opening (and later, reconnecting) the connection automatically.

**Server-side:** this GET request hits the Express route (`app.get('/events', ...)`), signaling "this client wants to subscribe, not just fetch once."

### Step 2 — Server Declares "This Is a Stream"

```javascript
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive'
});
```

- `Content-Type: text/event-stream` — tells the browser (and any proxy in between) to parse this as an SSE stream, not a normal file download. This is what makes `EventSource` start firing events.
- `Cache-Control: no-cache` — stops intermediaries from caching a "snapshot" of a stream that's supposed to be live.
- `Connection: keep-alive` — signals the underlying TCP connection should stay open rather than closing after this response.

Note: there's no `res.end()` — intentional. The server holds the connection open indefinitely.

**Client-side:** as soon as these headers arrive, the browser's `EventSource` considers the connection open and waits for data chunks.

### Step 3 — Server Pushes Data Periodically

```javascript
let counter = 0;
const interval = setInterval(() => {
  counter++;
  const payload = { time: new Date().toISOString(), counter };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}, 2000);
```

Every 2 seconds, the server writes a chunk into the same still-open response:
```
data: {"time":"...","counter":1}

```
- `data: ` prefix marks the payload line.
- The **blank line** (`\n\n`) is the event terminator — tells the client "this event is complete, deliver it now."

**Client-side:** every time a complete `data: ...\n\n` block arrives, the browser triggers:
```javascript
source.onmessage = (event) => {
  const data = JSON.parse(event.data);
  ...
};
```
`event.data` is exactly the string after `data: ` — the client updates the UI reactively, never polling.

### Step 4 — Heartbeats Keep the Connection Alive

```javascript
const heartbeat = setInterval(() => res.write(':\n\n'), 20000);
```

A line starting with `:` is an SSE **comment** — clients ignore it as data, but it still counts as "traffic" on the connection. This matters for infrastructure sitting between server and client (load balancers, gateways, proxies) that watch for idle connections and kill quiet ones. This resets the idle timer without triggering `onmessage`.

**Client-side:** nothing visible happens — `EventSource` silently discards comment lines. This step exists purely for the transport path.

### Step 5 — Cleanup When the Client Disconnects

```javascript
req.on('close', () => {
  clearInterval(interval);
  clearInterval(heartbeat);
});
```

If the client closes the tab or the network drops, the server is notified via `close` on the request object. Without this, you'd leak a `setInterval` per abandoned client.

**Client-side:** if the *server* goes away or the network blips, `EventSource` fires `onerror` and **automatically retries the connection** — no code required:
```javascript
source.onerror = () => {
  console.log('Connection lost — browser will auto-reconnect');
};
```

### Summary Table — Who's Responsible for What

| Concern | Server does | Client does |
|---|---|---|
| Open connection | Accepts GET, keeps response open | Calls `new EventSource(url)` once |
| Signal stream mode | Sends `Content-Type: text/event-stream` | Browser auto-detects and parses accordingly |
| Send data | Writes `data: ...\n\n` whenever new info exists | Receives via `onmessage`, no polling |
| Keep connection alive | Writes heartbeat comments | Ignores comment lines silently |
| Handle disconnects | Listens for `req.on('close')`, frees resources | Auto-reconnects via `onerror`, resumes seamlessly |

---

## 4. Where the Server Actually Runs (Demo vs. Microservices)

### In the demo: one server does both jobs

```javascript
app.use(express.static('public'));   // Job 1: serve index.html
app.get('/events', ...);              // Job 2: serve the SSE stream
app.listen(3000, ...);
```

Running `node server.js` starts **one Node.js process** on `http://localhost:3000` that handles two kinds of requests:

| Request | Handled by | What it returns |
|---|---|---|
| `GET http://localhost:3000/` | `express.static('public')` | The `index.html` file (once, normal HTTP) |
| `GET http://localhost:3000/events` | `app.get('/events', ...)` | The ongoing SSE stream (kept open) |

- **`server.js`** runs on the server machine as a Node.js process — never inside the browser.
- **`index.html`**'s *file* lives on the server's disk, but its *code* (the `<script>` block with `EventSource`) only executes once the browser downloads and runs it — that's client-side code, even though the file is stored/served from the server.

**Sequence:**
1. Browser requests `GET /` → Node server → `express.static` returns `index.html` (one-time response).
2. Browser parses HTML, runs the `<script>` tag **locally in the browser** — this is where `new EventSource('/events')` executes.
3. That call makes a *second*, separate request: `GET /events`, to the **same server** — hits the route that stays open and streams data.

### In real microservices: these jobs are usually split

- A **static hosting layer** (e.g., Azure Static Web Apps, a CDN, or Nginx serving a built React/Angular app) serves `index.html` and JS bundles — one-time file delivery.
- A **separate backend microservice** (different host/port/container) exposes the `/events` SSE endpoint — the long-lived stream.

In that case, the browser's `EventSource` call points to a **different origin**:
```javascript
const source = new EventSource('https://api.myapp.com/events');
```

This introduces two new concerns: **CORS** (covered below) and **routing through the API gateway/load balancer** (covered in section 6).

---

## 5. CORS — Cross-Origin Resource Sharing (Simple Explanation)

**CORS** is a security rule enforced by **browsers** (not servers) that says:

> "A webpage loaded from Origin A is not allowed to fetch data from Origin B, unless Origin B explicitly says 'yes, A is allowed to talk to me.'"

An "origin" = protocol + domain + port combined. These are all *different* origins:
- `https://app.mycompany.com`
- `https://api.mycompany.com`
- `http://localhost:3000`
- `https://app.mycompany.com:8443` (different port = different origin)

### Why This Rule Exists

Without CORS, if you're logged into your bank in one tab, any malicious website in another tab could silently fire background requests to your bank's API using your session cookies and read the response. CORS prevents a page from one origin from freely reading responses from another origin unless that origin opts in.

**Important nuance:** CORS doesn't stop the *request* from being sent — it stops the **browser from letting your JavaScript read the response**, unless the server says it's OK.

### How the Server "Says Yes"

The target server includes a response header:
```
Access-Control-Allow-Origin: https://app.mycompany.com
```
If present and matching, the browser lets the JS read the response. If missing or mismatched, the browser blocks it — even though the server actually processed the request — and a CORS error shows up in the console.

### Applying This to a Two-Microservice Setup

- **UI microservice**: `https://app.mycompany.com` — serves `index.html` + JS bundle
- **SSE/API microservice**: `https://api.mycompany.com` — serves `/events`

The browser loads the page from `app.mycompany.com`, then runs:
```javascript
const source = new EventSource('https://api.mycompany.com/events');
```

This is cross-origin. The browser only lets this SSE connection deliver data to the page's JS if `api.mycompany.com` responds with a header allowing `app.mycompany.com` as a permitted origin.

**What the SSE microservice needs to send**, alongside the SSE headers:
```
Access-Control-Allow-Origin: https://app.mycompany.com
```

With Express, one line via the `cors` middleware:
```javascript
const cors = require('cors');
app.use(cors({ origin: 'https://app.mycompany.com' }));
```

Without this, the connection opens but the browser refuses to expose the streamed data to `onmessage` — it looks like the stream is "silently broken," a confusing thing to debug without knowing CORS is the cause.

### SSE-Specific CORS Gotchas

- **Credentials/cookies**: if the SSE endpoint relies on a session cookie for auth, `EventSource` needs `{ withCredentials: true }`, and the server can no longer use a wildcard `*` for `Access-Control-Allow-Origin` — it must echo back the exact origin, plus send `Access-Control-Allow-Credentials: true`.
- **Preflight**: native `EventSource` GET requests usually skip the OPTIONS preflight check — but if using custom headers (e.g., an auth token) via a manual `fetch`-based SSE polyfill instead, a preflight `OPTIONS` request is sent first and the server must answer it too.
- **Wildcard `*` won't work with credentials**: `Access-Control-Allow-Origin: *` is disallowed by browsers when the request includes credentials — the exact origin must be specified instead.

### CORS vs. Application Gateway

CORS is a browser-vs-server concern, decided by response headers from the actual backend microservice — not by Application Gateway. Application Gateway just needs to pass those CORS headers through untouched (which it does by default) while separately handling buffering/timeout settings for SSE. The two configurations are unrelated but both must be correct for the whole thing to work end-to-end: **CORS lets the browser read the stream; Application Gateway settings make sure the stream keeps flowing without being cut off or buffered.**

---

## 6. SSE in Azure with a Microservices Architecture

SSE depends on a connection staying open and unbuffered end-to-end. Every hop in between (Load Balancer, Application Gateway, API Management, ingress) has its own idle-timeout and buffering behavior — if any hop buffers the response or times out the connection, SSE breaks silently (client just stops getting updates, or the connection drops).

### Azure Load Balancer (Layer 4 / TCP)

- Azure Load Balancer forwards TCP only — it doesn't understand HTTP semantics, so it won't buffer the SSE payload. But it **does have a TCP idle timeout**, default 4 minutes, configurable up to 30 minutes on the public IP.
- If the SSE stream can go quiet longer than that, either raise the idle timeout or (better) send periodic heartbeat comments so traffic never actually goes idle.

### Azure Application Gateway (Layer 7)

This needs the most care since it terminates HTTP and can buffer responses.

- **Response Buffers** on Application Gateway should be **disabled** so it streams responses to clients as received from the backend instead of waiting to buffer the whole response.
- The **backend request timeout** in Backend Settings must be configured to exceed the idle time between events, otherwise Application Gateway kills the connection prematurely.
- **TCP idle timeout** on the gateway's frontend public IP defaults to 4 minutes, configurable up to 30 minutes. **Keep-Alive timeout** is 120s (v1 SKU) or 75s (v2 SKU) — TCP idle timeout should be set equal to or longer than the keep-alive timeout to avoid conflicts.
- **HTTP/2** connections to the App Gateway frontend have a non-configurable **180-second idle timeout** — worth knowing if forcing HTTP/2.
- Real-world guidance: send heartbeat comment lines every 15–30 seconds, disable response caching, and turn off request/response body logging in Application Insights/Monitor/Event Hubs (logging middleware often buffers the body internally, breaking the stream).
- **Application Gateway for Containers** (AKS scenario) has its own model: idle timeout is currently fixed at **5 minutes** — if the app doesn't send/receive data within that window, send a keep-alive (a comment line prefixed with `:`) to prevent closure.

### Practical Checklist for a Microservices Setup

1. **API Gateway / App Gateway layer**: disable response buffering, raise backend request timeout past the longest idle gap, keep TCP idle timeout ≥ keep-alive timeout.
2. **Service itself**: disable output buffering in the framework (e.g., Nginx `proxy_buffering off`, ASP.NET `DisableBuffering()`), flush after every write.
3. **Heartbeats**: emit a comment or no-op event every 15–30 seconds regardless of real data, so no hop's idle-timer trips.
4. **Sticky routing**: if scaling the SSE-serving microservice horizontally, use session affinity (or push events through a shared broker like Azure SignalR / Redis Pub-Sub / Service Bus) so reconnects can land anywhere and still resume the stream.
5. **Logging/App Insights middleware**: turn off body capture on long streams — it silently buffers and delays delivery.
6. **Prefer Linux-based hosting** for the SSE-emitting service — Windows App Service plans have limited SSE support due to IIS, while Linux handles it better.
7. **CORS**: if the UI and SSE endpoint are on different origins (typical in microservices), configure `Access-Control-Allow-Origin` on the SSE service to explicitly allow the UI's origin (see section 5).

If the use case needs **bidirectional** communication (client also sends frequent messages), it's worth comparing SSE against **Azure SignalR Service** (also fits microservices, handles scaling/reconnects) or WebSockets — but for pure server→client push, plain SSE behind a properly configured Application Gateway works well and keeps the architecture simple.

---

*End of notes.*
