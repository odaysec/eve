import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import {
  readDevelopmentRuntimeArtifactsSnapshotRoot,
  resolveDevelopmentRuntimeArtifactsPointerPath,
} from "../../src/internal/nitro/dev-runtime-artifacts.js";
import { STRUCTURAL_RELOAD_LOG_LINE } from "../../src/internal/nitro/host/dev-watcher-log.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";

// Keep the dev TUI's glyph set deterministic across CI hosts so the
// screen assertions below remain stable.
process.env.EVE_TUI_UNICODE = "1";

const scenarioApp = useScenarioApp();
const DEV_SERVER_SCENARIO_TIMEOUT_MS = 360_000;
const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: {
    ...Object.fromEntries(
      Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
        ([path]) => !path.startsWith("agent/channels/"),
      ),
    ),
    "agent/channels/dev-generation.ts": [
      'import { defineChannel, GET } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [GET("/dev-generation", () => new Response(process.env.EVE_SCENARIO_RELOAD ?? process.env.EVE_WEBSOCKET_RELOAD ?? "initial"))],',
      "});",
      "",
    ].join("\n"),
  },
};
const WEBSOCKET_DEV_SERVER_DESCRIPTOR: ScenarioAppDescriptor = {
  ...DEV_SERVER_AGENT_DESCRIPTOR,
  files: {
    ...DEV_SERVER_AGENT_DESCRIPTOR.files,
    "agent/channels/socket.ts": [
      'import { defineChannel, WS } from "eve/channels";',
      "",
      "export default defineChannel({",
      '  routes: [WS("/socket", () => ({',
      "    message(peer, message) {",
      '      const transportHeader = peer.request.headers.has("x-eve-dev-worker-metadata") ? "exposed" : "hidden";',
      '      peer.send(`${transportHeader}:${peer.remoteAddress ?? "missing"}:${message.text()}`);',
      "    },",
      "  }))],",
      "});",
      "",
    ].join("\n"),
  },
};

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function hasUnsupportedWindowsEsmImport(text: string): boolean {
  return (
    text.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    text.includes("Received protocol 'g:'") ||
    text.includes('Received protocol "g:"')
  );
}

function hasKnownDevServerFailure(text: string): boolean {
  return (
    hasUnsupportedWindowsEsmImport(text) ||
    text.includes("UNRESOLVED_IMPORT") ||
    text.includes("ECONNRESET") ||
    text.includes("socket hang up") ||
    (text.includes("ERR_MODULE_NOT_FOUND") && text.includes("authored-module-map-loader"))
  );
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));

  return match?.[1];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string,
  timeoutMs: number = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(failureMessage);
    }
    await wait(100);
  }
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev to print its server URL.",
            `stdout:\n${input.getOutput().stdout}`,
            `stderr:\n${input.getOutput().stderr}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout.off("data", handleOutput);
      input.child.stderr.off("data", handleOutput);
      input.child.off("error", settleReject);
      input.child.off("exit", handleExit);
    };

    const settleResolve = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const output = input.getOutput();
      const combinedOutput = `${output.stdout}\n${output.stderr}`;

      if (hasKnownDevServerFailure(combinedOutput)) {
        settleReject(
          new Error(
            [
              "eve dev emitted a known reload or generated-bundle failure.",
              `stdout:\n${output.stdout}`,
              `stderr:\n${output.stderr}`,
            ].join("\n\n"),
          ),
        );
        return;
      }

      const url = parseServerUrl(output.stdout);

      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      const output = input.getOutput();

      settleReject(
        new Error(
          [
            `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${output.stdout}`,
            `stderr:\n${output.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    input.child.stdout.on("data", handleOutput);
    input.child.stderr.on("data", handleOutput);
    input.child.once("error", settleReject);
    input.child.once("exit", handleExit);
    handleOutput();
  });
}

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  await waitForWebSocketEvent(socket, "open", () => undefined);
}

async function waitForWebSocketMessage(socket: WebSocket): Promise<string> {
  return await waitForWebSocketEvent(socket, "message", (event) => String(event.data));
}

async function waitForWebSocketClose(socket: WebSocket): Promise<void> {
  await waitForWebSocketEvent(socket, "close", () => undefined);
}

async function waitForWebSocketEvent<T>(
  socket: WebSocket,
  eventName: "close" | "message" | "open",
  select: (event: MessageEvent) => T,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket ${eventName}.`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(deadline);
      socket.removeEventListener(eventName, onEvent as EventListener);
      socket.removeEventListener("error", onError);
    };
    const onEvent = (event: Event) => {
      cleanup();
      resolve(select(event as MessageEvent));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket failed while waiting for ${eventName}.`));
    };
    socket.addEventListener(eventName, onEvent as EventListener, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        // Activate the deterministic mock-model adapter in the spawned dev
        // server so the streamed turn completes without model credentials.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const url = await waitForServerUrl({
    child,
    getOutput: () => ({
      stderr,
      stdout,
    }),
  });

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
    url,
  };
}

describe("eve dev server", () => {
  it(
    "keeps an admitted websocket on its worker while a ready replacement is promoted",
    async () => {
      const app = await scenarioApp(WEBSOCKET_DEV_SERVER_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const socketUrl = new URL("/socket", server.url);
      socketUrl.protocol = "ws:";
      const socket = new WebSocket(socketUrl);

      try {
        await waitForWebSocketOpen(socket);
        const firstMessage = waitForWebSocketMessage(socket);
        socket.send("before");
        await expect(firstMessage).resolves.toBe("hidden:127.0.0.1:before");

        await writeFile(join(app.appRoot, ".env.local"), "EVE_WEBSOCKET_RELOAD=1\n");
        await waitForCondition(async () => {
          const generation = await fetch(new URL("/dev-generation", server.url));
          return (await generation.text()) === "1";
        }, `Timed out waiting for websocket worker replacement.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);

        const nextMessage = waitForWebSocketMessage(socket);
        socket.send("after");
        await expect(nextMessage).resolves.toBe("hidden:127.0.0.1:after");
      } finally {
        if (socket.readyState === WebSocket.OPEN) {
          const closed = waitForWebSocketClose(socket);
          socket.close();
          await closed;
        }
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "rebuilds after its startup runtime generation is force-pruned and completes a streamed turn",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const responseText = await response.text();

        expect(
          response.status,
          [
            `Expected ${EVE_HEALTH_ROUTE_PATH} to return 200.`,
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(JSON.parse(responseText)).toMatchObject({
          ok: true,
          status: "ready",
        });

        const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(app.appRoot);
        const startupRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
        if (startupRuntimeRoot === undefined) {
          throw new Error("Expected eve dev to publish an initial runtime snapshot.");
        }

        await writeFile(
          join(app.appRoot, "agent", "instructions.md"),
          "Use the weather tool and answer with the current conditions.\n",
        );
        await waitForCondition(() => {
          const currentRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
          return currentRuntimeRoot !== undefined && currentRuntimeRoot !== startupRuntimeRoot;
        }, `Timed out waiting for authored HMR.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);

        const authoredRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
        if (authoredRuntimeRoot === undefined) {
          throw new Error("Expected authored HMR to publish a runtime snapshot.");
        }

        await rm(startupRuntimeRoot, { force: true, recursive: true });
        expect(existsSync(startupRuntimeRoot)).toBe(false);

        await writeFile(join(app.appRoot, ".env.local"), "EVE_SCENARIO_RELOAD=1\n");
        await waitForCondition(
          () => server.stdout().includes(STRUCTURAL_RELOAD_LOG_LINE),
          `Timed out waiting for a structural Nitro reload.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );
        await waitForCondition(() => {
          const currentRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
          return currentRuntimeRoot !== undefined && currentRuntimeRoot !== authoredRuntimeRoot;
        }, `Timed out waiting for the structural reload snapshot.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);
        await waitForCondition(async () => {
          const generation = await fetch(new URL("/dev-generation", server.url));
          return (await generation.text()) === "1";
        }, `Timed out waiting for a ready replacement worker.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);
        let messageResult: Awaited<ReturnType<typeof sendDevelopmentMessage>>;
        try {
          messageResult = await sendDevelopmentMessage({
            message: "hello world",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
          });
        } catch (error) {
          throw new Error(
            [
              `Expected dev message route to complete without throwing: ${String(error)}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevServerFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
