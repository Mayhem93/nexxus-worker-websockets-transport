# nexxus-worker-websockets-transport

> Executable WebSocket transport worker for a Nexxus deployment — the process that holds live client connections and pushes model changes out to them in real time.

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0.0-blue.svg)](https://www.typescriptlang.org/)

---

## What this is

`nexxus-worker-websockets-transport` is the **runnable WebSocket transport worker process** for a Nexxus deployment. It's a thin bootstrap around [`@mayhem93/nexxus-worker-lib`](https://www.npmjs.com/package/@mayhem93/nexxus-worker-lib): reads a config file, resolves the pluggable services (logger, DB adapter, MQ adapter, Redis), and starts both a WebSocket server (for clients) and a message-queue consumer (for events routed from the Transport Manager).

Same config shape, same pluggable-service pattern, same lifecycle as every other Nexxus node — this is the process at the last step of the pipeline: the one talking directly to end-user clients.

---

## What it does

The WS transport worker is where "server-side pipeline" hands off to "client". Two responsibilities at once:

1. **Runs a WebSocket server** on the configured port. Clients connect, exchange a small handshake to associate the connection with a `deviceId`, then keep the socket open.
2. **Consumes its slot's queue** — `websockets-transport_<slot>` — where the Transport Manager publishes `device_message` payloads targeting devices held by this worker. For each incoming message, the worker looks up the matching live client and delivers the `model_created` / `model_updated` / `model_deleted` event over the socket.

End-to-end, continuing from the earlier stages of the pipeline:

```
nexxus-worker-transport-manager
              ↓ (routes to the specific worker holding this device's connection)
   [websockets-transport_N queue]
              ↓
nexxus-worker-websockets-transport  ⇔  live WebSocket  ⇔  end-user client
```

**Slot semantics.** WS workers are horizontally scalable but *slotted*. At startup each instance queries Hub for the current count of `websockets-transport` role members and takes the next slot number for itself, then binds queue `websockets-transport_<slot>`. A device's live connection lives on exactly one worker; that worker's queue name gets recorded in Redis when the client registers, and the Transport Manager uses that record to route events to the right slot. This is what "volatile transport" means in Nexxus — the mapping only lives for the connection's lifetime.

---

## Why a WS transport worker instead of the Transport Manager pushing directly

The Transport Manager could theoretically hold sockets itself. Two reasons that's a bad idea:

- **Physical connection state has to live *somewhere*.** The Transport Manager is a routing step — it looks up Redis, evaluates filters, and enqueues. Making it also hold thousands of live TCP connections merges two different resource-management problems (routing CPU + socket file descriptors) into one process. They fail differently and scale differently.
- **Transport-specific isolation.** WebSocket is one transport; MQTT, SSE, gRPC-streaming, and eventually push-notification bridges would be others. Each has its own protocol library, keepalive semantics, disconnect behavior, and deployment characteristics. Splitting them into per-transport workers means a bug or scaling need in WS doesn't force a redeploy of MQTT (and vice versa).
- **Slot-based routing.** Because a device's connection lives on one specific worker, notifications need to be delivered to that specific worker — not any worker in the pool. The Transport Manager knows which slot to hit via Redis; the target worker just consumes its own queue. Cleanly separates "who should hear this?" (Transport Manager's job) from "how do we actually push it?" (this worker's job).

---

## What goes through the WS transport worker

**`device_message` payloads on the slot-suffixed queue.** Every message the Transport Manager routes to a device currently held here shows up on `websockets-transport_<slot>`. Payloads carry the specific device IDs and the change event to deliver:

- `model_created` — the newly-created document, delivered as-is over the client's socket.
- `model_updated` — the model identity + JSON patch operations, delivered to every device whose subscription channel this update matched.
- `model_deleted` — the model identity, so the client can drop it from local state.

Plus the client-facing side:

- **Inbound WebSocket connections** — a client connects, is added to the "unregistered" set, then sends a `register` message with its `deviceId`. On successful registration (Redis validates the device belongs to this deployment), the client moves to the "registered" map keyed by `deviceId`.
- **Client disconnects** — WS `close` triggers cleanup: the registered mapping is removed, `NexxusDevice` is marked `offline` in Redis, and all of that device's subscriptions are torn down (volatile behavior).

## What does NOT go through the WS transport worker

- **Notifications for devices held by a *different* WS worker.** Each worker only consumes its own slot's queue. The Transport Manager makes the routing decision; this worker is passive on that front.
- **Non-WebSocket clients.** MQTT, SSE, push notifications, etc. each go to their own transport worker (when they exist). This worker only speaks WebSocket.
- **Subscription creation.** Clients ask the API to subscribe them to channels; the API writes the subscription to Redis. This worker only *reads* the "device is online / registered" state; subscription lifecycle isn't its problem.
- **Any DB writes.** No writes happen here. The Writer has already persisted; the Transport Manager has already resolved subscribers. This worker's job is delivery only.
- **Reads or state queries from clients.** WS is push-only in Nexxus. If a client wants to read a resource, it hits the REST API.

Rule of thumb: **connections and pushes to WebSocket clients — yes. Everything else — no.**

---

## Configuration

Same shape as the other workers, with one addition: `app.port` — the WebSocket server's listen port. The bootstrap-time keys:

```json
{
  "database": { "host": "localhost", "port": 9200 },
  "message_queue": { "host": "localhost", "port": 5672, "user": "guest", "password": "guest" },
  "redis": { "host": "localhost", "port": 6379, "cluster": false, "password": "1234test" },
  "app": {
    "name": "my-ws-transport",
    "port": 6001,
    "logger": "WinstonNexxusLogger",
    "database": "NexxusElasticsearchDb",
    "message_queue": "NexxusRabbitMq",
    "management": { "port": 5003, "token": "replace-me" },
    "hub": { "endpoint": "http://hub:8080", "token": "replace-me" }
  },
  "logger": { "level": "info", "logType": "json", "transports": [ { "type": "stdout" } ] }
}
```

- `app.port` — where clients connect via `ws://` or `wss://`. Distinct from the management server's port.
- `app.hub` — recommended (not optional in practice). Slot picking depends on querying Hub for the current role membership count. Without Hub, the worker falls back to slot `1`, which is fine for a single-instance deployment but not for a scaled pool.

Config file lookup order (first hit wins):

1. Explicit path passed to `NexxusConfigManager`
2. `NXX_CONF_PATH` environment variable
3. `/etc/nexxus/nexxus.conf.json` (the default)

---

## Running

**Prerequisites:**

- Node.js ≥ 24
- Same infrastructure as the other workers: DB (for schema loading at startup), MQ, Redis
- Each `websockets-transport_<slot>` queue needs to exist on the broker before the worker starts consuming it (provisioned out-of-band)

**Build and start:**

```bash
npm install
npm run build
npm start
```

`npm start` runs `node --enable-source-maps dist/index.js`.

**Scaling.** Because devices are bound to a specific worker's slot, adding a new WS worker doesn't rebalance existing connections — they stay where they are until they naturally reconnect (network hiccup, deploy, client restart). New connections coming in through the load balancer land on whichever worker accepts them. Removing a worker forcibly closes its connections; clients reconnect elsewhere and re-register, updating Redis's device→transport mapping automatically.

---

## Status

🚧 **Pre-alpha.** The WebSocket handshake shape, per-transport queue naming, and volatile-lifecycle semantics may still shift alongside the underlying library.

---

## Related

- [`nexxus-lib`](https://github.com/Mayhem93/nexxus-lib) — the umbrella framework: config manager, base service, pluggable-service resolvers, worker + transport framework
- [`@mayhem93/nexxus-worker-lib`](https://www.npmjs.com/package/@mayhem93/nexxus-worker-lib) — the actual worker framework this repo bootstraps; contains `NexxusWebsocketsTransportWorker`
- [`@mayhem93/nexxus-core-lib`](https://www.npmjs.com/package/@mayhem93/nexxus-core-lib) — shared types, config manager, logger, Hub client

---

## License

MPL-2.0
