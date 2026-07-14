import type { H3Event } from "nitro";
import type { Agent, RouteContext } from "#public/definitions/channel.js";
import {
  createCrossChannelReceiveFn,
  toCrossChannelTargets,
} from "#channel/cross-channel-receive.js";
import type { DeliverInput, RunInput, Runtime } from "#channel/types.js";
import type { RouteHandlerArgs, WebSocketPeer, WebSocketRouteHooks } from "#channel/routes.js";
import { createSendFn } from "#channel/send.js";
import { createGetSessionFn } from "#channel/session.js";
import { createLogger, logError } from "#internal/logging.js";
import { attachAgentInfoRouteResponse } from "#internal/nitro/routes/channel-route-context.js";
import type { NitroArtifactsConfig } from "#internal/nitro/routes/runtime-artifacts.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { withVercelOidcProjectResolver } from "#runtime/governance/auth/vercel-oidc-project.js";
import {
  DEVELOPMENT_WORKER_METADATA_HEADER,
  readDevelopmentWorkerRequestMetadata,
} from "#internal/nitro/host/dev-worker-metadata.js";

const log = createLogger("channel.dispatch");

interface BuiltRouteArgs {
  readonly agent: Agent;
  readonly args: RouteHandlerArgs;
  readonly backgroundTasks: Promise<unknown>[];
}

/**
 * Dispatches one channel request identified by `routeKey`.
 *
 * Each channel route is mounted as its own virtual Nitro handler with the
 * route key and artifacts config baked in. Nitro's router matches the URL
 * and populates `event.context.params`, so no custom URL matching is
 * needed — the handler looks up the channel by its `(method, urlPath)` key
 * directly. When routes register background work through `ctx.waitUntil`,
 * Nitro forwards that work to `event.waitUntil()` so webhook
 * acknowledgements can return immediately.
 *
 * Two dispatch shapes: authored channels (`defineChannel` and its
 * wrappers) carry a `handler` field and receive `RouteHandlerArgs` with
 * `send`, `getSession`, etc. Framework-internal channels (the
 * connection callback route) build `ResolvedChannelDefinition` directly
 * with just `fetch` and receive a `RouteContext` carrying `agent`.
 */
export async function dispatchChannelRequest(
  event: H3Event,
  routeKey: string,
  config: NitroArtifactsConfig,
): Promise<Response> {
  const bundle = await resolveNitroChannelRuntimeBundle(config, event.req);

  const matchedChannel = bundle.channels.find(
    (channel) => `${channel.method.toUpperCase()} ${channel.urlPath}` === routeKey,
  );

  if (matchedChannel === undefined) {
    return Response.json(
      { error: "No matching channel for this request.", ok: false },
      { status: 404 },
    );
  }

  const routeArgs = buildRouteArgs(event, bundle, matchedChannel.name, config);

  let response: Response;

  try {
    response = await withDevelopmentVercelOidcContext(config, event.req, async () => {
      if (matchedChannel.handler) {
        // Authored CompiledChannel route — build RouteHandlerArgs.
        return await matchedChannel.handler(event.req, routeArgs.args);
      }

      // Framework-internal fetch-only channel (e.g. the connection
      // callback route). Build a RouteContext with the agent handle.
      const ctx: RouteContext = {
        agent: routeArgs.agent,
        waitUntil: routeArgs.args.waitUntil,
        params: routeArgs.args.params,
        requestIp: routeArgs.args.requestIp,
      };

      return await matchedChannel.fetch(event.req, ctx);
    });
  } catch (error) {
    // Without this a handler throw is only Nitro's default 5xx, with no eve log.
    const errorId = logError(log, "channel handler threw", error, {
      routeKey,
      channel: matchedChannel.name,
    });
    flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);
    return Response.json({ error: "Channel handler failed.", errorId, ok: false }, { status: 500 });
  }

  flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);

  return response;
}

export async function dispatchChannelWebSocketRequest(
  event: H3Event,
  routeKey: string,
  config: NitroArtifactsConfig,
): Promise<WebSocketRouteHooks> {
  const bundle = await resolveNitroChannelRuntimeBundle(config, event.req);

  const matchedChannel = bundle.channels.find(
    (channel) => `${channel.method.toUpperCase()} ${channel.urlPath}` === routeKey,
  );

  if (matchedChannel === undefined || matchedChannel.websocket === undefined) {
    return rejectWebSocketUpgrade(
      { error: "No matching websocket channel for this request.", ok: false },
      404,
    );
  }

  const websocket = matchedChannel.websocket;
  const routeArgs = buildRouteArgs(event, bundle, matchedChannel.name, config);

  try {
    const hooks = await withDevelopmentVercelOidcContext(
      config,
      event.req,
      async () => await websocket(event.req, routeArgs.args),
    );
    flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);
    return protectWebSocketPeerMetadata(hooks, routeArgs.args.requestIp);
  } catch (error) {
    const errorId = logError(log, "channel websocket handler threw", error, {
      routeKey,
      channel: matchedChannel.name,
    });
    flushBackgroundTasks(event, routeArgs.backgroundTasks, routeKey, matchedChannel.name);
    return rejectWebSocketUpgrade(
      { error: "Channel websocket handler failed.", errorId, ok: false },
      500,
    );
  }
}

async function withDevelopmentVercelOidcContext<T>(
  config: NitroArtifactsConfig,
  request: Request,
  callback: () => Promise<T>,
): Promise<T> {
  if (config.kind !== "development") {
    return await callback();
  }

  return await withVercelOidcProjectResolver(
    {
      request,
      resolveCurrentProject: async () => {
        const link = await readVercelProjectLink(config.appRoot);
        return link === undefined
          ? undefined
          : { environment: "development", projectId: link.projectId };
      },
    },
    callback,
  );
}

function buildRouteArgs(
  event: H3Event,
  bundle: Awaited<ReturnType<typeof resolveNitroChannelRuntimeBundle>>,
  channelName: string,
  config: NitroArtifactsConfig,
): BuiltRouteArgs {
  const requestId = readVercelRequestId(event.req.headers);
  const requestIp = extractSocketIp(event);
  const backgroundTasks: Promise<unknown>[] = [];
  const rawParams = (event.context.params as Record<string, string>) ?? {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    params[key] = decodeURIComponent(value);
  }

  const waitUntil = (task: Promise<unknown>) => {
    backgroundTasks.push(task);
  };
  const channel = bundle.channels.find((candidate) => candidate.name === channelName);
  const adapter = channel?.adapter ?? { kind: "channel" };
  const agent = createRouteAgent(bundle.runtime, requestId);
  const send = createSendFn(bundle.runtime, adapter, channelName, { requestId });
  const getSession = createGetSessionFn(bundle.runtime);
  const receive = createCrossChannelReceiveFn(
    bundle.runtime,
    toCrossChannelTargets(bundle.channels),
  );

  const args = attachAgentInfoRouteResponse(
    {
      send,
      getSession,
      receive,
      params,
      waitUntil,
      requestIp,
    },
    async () => {
      const { handleAgentInfoRequestForRequest } = await import("#internal/nitro/routes/info.js");
      return await handleAgentInfoRequestForRequest(config, event.req);
    },
  );

  return {
    agent,
    args,
    backgroundTasks,
  };
}

function createRouteAgent(runtime: Runtime, requestId: string | undefined): Agent {
  return {
    async deliver(input) {
      const deliverInput: DeliverInput = { ...input, requestId }; // Avoid mutating a frozen caller input.
      return await runtime.deliver(deliverInput);
    },
    async getEventStream(sessionId, options) {
      return await runtime.getEventStream(sessionId, options);
    },
    async run(input) {
      const runInput: RunInput = { ...input, requestId }; // Avoid mutating a frozen caller input.
      return await runtime.run(runInput);
    },
  };
}

function readVercelRequestId(headers: Headers): string | undefined {
  const requestId = headers.get("x-vercel-id")?.trim();
  return requestId === "" ? undefined : requestId;
}

function rejectWebSocketUpgrade(
  body: Record<string, unknown>,
  status: number,
): WebSocketRouteHooks {
  return {
    upgrade() {
      throw Response.json(body, { status });
    },
  };
}

/**
 * Drains channel background tasks through `event.waitUntil`, logging each
 * rejection. A bare `waitUntil(allSettled(tasks))` never rejects and so
 * silently discards failed post-ack work (the Slack inbound dispatch).
 */
function flushBackgroundTasks(
  event: H3Event,
  tasks: Promise<unknown>[],
  routeKey: string,
  channel: string,
): void {
  if (tasks.length === 0) {
    return;
  }
  event.waitUntil(
    Promise.allSettled(tasks).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          logError(log, "channel background task failed", result.reason, {
            routeKey,
            channel,
          });
        }
      }
    }),
  );
}

function extractSocketIp(event: H3Event): string | null {
  const trustedAddress = readDevelopmentWorkerRequestMetadata(event.req)?.clientAddress;
  if (trustedAddress !== undefined) {
    return trustedAddress;
  }

  const ip = event.req.ip;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}

function protectWebSocketPeerMetadata(
  hooks: WebSocketRouteHooks,
  requestIp: string | null,
): WebSocketRouteHooks {
  const peers = new WeakMap<WebSocketPeer, WebSocketPeer>();
  const wrap = (peer: WebSocketPeer): WebSocketPeer => {
    const existing = peers.get(peer);
    if (existing !== undefined) {
      return existing;
    }

    const requestHeaders = new Headers(peer.request.headers);
    requestHeaders.delete(DEVELOPMENT_WORKER_METADATA_HEADER);
    const publicRequest = new Proxy(peer.request, {
      get(target, property) {
        if (property === "headers") {
          return requestHeaders;
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wrapped = new Proxy(peer, {
      get(target, property) {
        if (property === "remoteAddress") {
          return requestIp ?? undefined;
        }
        if (property === "request") {
          return publicRequest;
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    peers.set(peer, wrapped);
    return wrapped;
  };
  const preserved: WebSocketRouteHooks = {};
  if (hooks.close !== undefined) {
    const close = hooks.close;
    preserved.close = async (peer, details) => await close(wrap(peer), details);
  }
  if (hooks.error !== undefined) {
    const error = hooks.error;
    preserved.error = async (peer, cause) => await error(wrap(peer), cause);
  }
  if (hooks.message !== undefined) {
    const message = hooks.message;
    preserved.message = async (peer, value) => await message(wrap(peer), value);
  }
  if (hooks.open !== undefined) {
    const open = hooks.open;
    preserved.open = async (peer) => await open(wrap(peer));
  }
  if (hooks.upgrade !== undefined) {
    preserved.upgrade = hooks.upgrade;
  }
  return preserved;
}
