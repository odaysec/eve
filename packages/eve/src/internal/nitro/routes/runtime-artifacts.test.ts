import { describe, expect, it } from "vitest";

import { COMPILED_AGENT_MANIFEST_VERSION } from "#compiler/manifest.js";
import { installBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import {
  resolveNitroCompiledArtifactsSource,
  resolveNitroRequestCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import { installDevelopmentWorkerRequestMetadata } from "#internal/nitro/host/dev-worker-metadata.js";

/**
 * Installs an empty compiled-artifact snapshot on the currently active runtime
 * session. Callers are expected to drive this inside a `withRuntimeSession`
 * scope so the install targets the scoped session rather than the
 * process-default singleton.
 */
function installEmptyBundledArtifacts(): void {
  const manifest = {
    agentId: "test-agent",
    agentRoot: "/tmp/agent",
    appRoot: "/tmp/app",
    channels: [],
    config: {
      model: {
        id: "openai/gpt-5.4-mini",
      },
      name: "Test Agent",
    },
    diagnosticsSummary: {
      errors: 0,
      warnings: 0,
    },
    disabledFrameworkTools: [],
    kind: "eve-agent-compiled-manifest",
    sandbox: null,
    schedules: [],
    skills: [],
    subagentEdges: [],
    subagents: [],
    tools: [],
    version: COMPILED_AGENT_MANIFEST_VERSION,
  };

  installBundledCompiledArtifacts({
    manifest: manifest as unknown as Parameters<
      typeof installBundledCompiledArtifacts
    >[0]["manifest"],
    moduleMap: {
      nodes: {},
    },
  });
}

/**
 * Runs `fn` inside a freshly-created, test-scoped `RuntimeSession`.
 *
 * Each test body gets its own session so installed compiled artifacts do
 * not leak across test boundaries or to the process-default session. This
 * replaces the earlier pattern of mutating the singleton via
 * `installBundledCompiledArtifacts` + `resetBundledCompiledArtifacts()` in
 * an `afterEach` hook, which guard rule 19 discourages: runtime state
 * should be scoped through `AlsContext` / `RuntimeSession`, not global.
 */
async function withScopedRuntimeSession<T>(fn: () => T | Promise<T>): Promise<T> {
  return await withRuntimeSession(createRuntimeSession("runtime-artifacts-test"), fn);
}

describe("resolveNitroCompiledArtifactsSource", () => {
  it("prefers disk artifacts in development mode even when bundled artifacts exist", async () => {
    await withScopedRuntimeSession(() => {
      installEmptyBundledArtifacts();
      const moduleMapLoaderPath = "/package/src/internal/authored-module-map-loader.ts";

      expect(
        resolveNitroCompiledArtifactsSource({
          appRoot: "/tmp/dev-app",
          devRuntimeArtifactsPointerPath: "/tmp/dev-app/.eve/dev-runtime/current.json",
          kind: "development",
          moduleMapLoaderPath,
        }),
      ).toMatchObject({
        appRoot: "/tmp/dev-app",
        kind: "disk",
        moduleMapLoaderPath,
        sandboxAppRoot: "/tmp/dev-app",
      });
    });
  });

  it("resolves a development request from its admitted generation", () => {
    const request = new Request("http://worker.test/");
    installDevelopmentWorkerRequestMetadata(request, {
      clientAddress: "192.0.2.10",
      generationId: "generation-a",
      runtimeAppRoot: "/tmp/dev-app/.eve/dev-runtime/snapshots/generation-a/source/app",
    });

    expect(
      resolveNitroRequestCompiledArtifactsSource(
        {
          appRoot: "/tmp/dev-app",
          devRuntimeArtifactsPointerPath: "/tmp/dev-app/.eve/dev-runtime/current.json",
          kind: "development",
          moduleMapLoaderPath: "/package/src/internal/authored-module-map-loader.ts",
        },
        request,
      ),
    ).toMatchObject({
      appRoot: "/tmp/dev-app/.eve/dev-runtime/snapshots/generation-a/source/app",
      kind: "disk",
      sandboxAppRoot: "/tmp/dev-app",
    });
  });

  it("rejects a development request without an admitted generation", () => {
    expect(() =>
      resolveNitroRequestCompiledArtifactsSource(
        {
          appRoot: "/tmp/dev-app",
          devRuntimeArtifactsPointerPath: "/tmp/dev-app/.eve/dev-runtime/current.json",
          kind: "development",
          moduleMapLoaderPath: "/package/src/internal/authored-module-map-loader.ts",
        },
        new Request("http://worker.test/"),
      ),
    ).toThrow("missing its admitted artifact generation");
  });

  it("uses bundled artifacts outside development mode when they exist", async () => {
    await withScopedRuntimeSession(() => {
      installEmptyBundledArtifacts();

      expect(
        resolveNitroCompiledArtifactsSource({
          kind: "production",
        }),
      ).toEqual({
        kind: "bundled",
      });
    });
  });

  it("does not fall back to the authored build path in production", async () => {
    await withScopedRuntimeSession(() => {
      const productionConfig = {
        appRoot: "/tmp/build-machine-app",
        kind: "production" as const,
      };
      expect(() => resolveNitroCompiledArtifactsSource(productionConfig)).toThrow(
        "requires bundled artifacts",
      );
    });
  });
});
