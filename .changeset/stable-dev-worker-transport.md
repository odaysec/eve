---
"eve": patch
---

Keep the `eve dev` listener stable while ready-gated workers are replaced. In-flight HTTP streams, request bodies, keep-alive connections, WebSockets, client addresses, and dev control requests now retain their admitted worker or cancel cleanly during reload and shutdown.
