import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import {
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKER_METADATA_HEADER,
  DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV,
  encodeDevelopmentWorkerMetadata,
  readDevelopmentWorkerRequestMetadata,
} from "#internal/nitro/host/dev-worker-metadata.js";
import installDevelopmentWorkerMetadataPlugin from "#internal/nitro/host/dev-worker-metadata-plugin.js";

const createScratchDirectory = useTemporaryDirectories();

describe("development worker metadata plugin", () => {
  afterEach(() => {
    delete process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
    delete process.env[DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV];
  });

  it("removes the transport header and installs only validated parent metadata", async () => {
    const appRoot = await createScratchDirectory("eve-dev-worker-metadata-");
    const generationId = "generation-a";
    const runtimeAppRoot = join(
      appRoot,
      ".eve",
      "dev-runtime",
      "snapshots",
      generationId,
      "source",
      "app",
    );
    const secret = "parent-secret";
    await mkdir(join(runtimeAppRoot, ".eve", "compile"), { recursive: true });
    await writeFile(
      join(runtimeAppRoot, ".eve", "compile", "compiled-agent-manifest.json"),
      "{}\n",
    );
    process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] = appRoot;
    process.env[DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV] = secret;

    let requestHook: ((event: { readonly req: Request }) => void) | undefined;
    installDevelopmentWorkerMetadataPlugin({
      hooks: {
        hook(_name, handler) {
          requestHook = handler;
        },
      },
    });
    const request = new Request("http://worker.test/", {
      headers: {
        [DEVELOPMENT_WORKER_METADATA_HEADER]: encodeDevelopmentWorkerMetadata({
          metadata: {
            clientAddress: "192.0.2.25",
            generationId,
            runtimeAppRoot,
          },
          secret,
        }),
      },
    });

    requestHook?.({ req: request });

    expect(request.headers.has(DEVELOPMENT_WORKER_METADATA_HEADER)).toBe(false);
    expect(readDevelopmentWorkerRequestMetadata(request)).toEqual({
      clientAddress: "192.0.2.25",
      generationId,
      runtimeAppRoot,
    });
  });

  it("rejects a signed runtime root outside the named generation", async () => {
    const appRoot = await createScratchDirectory("eve-dev-worker-metadata-outside-");
    const outsideRuntimeRoot = await createScratchDirectory("eve-dev-worker-metadata-target-");
    const secret = "parent-secret";
    process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV] = appRoot;
    process.env[DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV] = secret;

    let requestHook: ((event: { readonly req: Request }) => void) | undefined;
    installDevelopmentWorkerMetadataPlugin({
      hooks: {
        hook(_name, handler) {
          requestHook = handler;
        },
      },
    });
    const request = new Request("http://worker.test/", {
      headers: {
        [DEVELOPMENT_WORKER_METADATA_HEADER]: encodeDevelopmentWorkerMetadata({
          metadata: {
            clientAddress: "192.0.2.25",
            generationId: "generation-a",
            runtimeAppRoot: outsideRuntimeRoot,
          },
          secret,
        }),
      },
    });

    expect(() => requestHook?.({ req: request })).toThrow("outside its generation");
  });
});
