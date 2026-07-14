import { existsSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  decodeDevelopmentWorkerMetadata,
  DEVELOPMENT_WORKER_APP_ROOT_ENV,
  DEVELOPMENT_WORKER_METADATA_HEADER,
  DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV,
  installDevelopmentWorkerRequestMetadata,
} from "#internal/nitro/host/dev-worker-metadata.js";

interface NitroRequestHookApp {
  readonly hooks: {
    hook(name: "request", handler: (event: { readonly req: Request }) => void): unknown;
  };
}

export default function installDevelopmentWorkerMetadataPlugin(
  nitroApp: NitroRequestHookApp,
): void {
  const appRoot = readRequiredEnvironment(DEVELOPMENT_WORKER_APP_ROOT_ENV);
  const secret = readRequiredEnvironment(DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV);

  nitroApp.hooks.hook("request", (event) => {
    const metadata = decodeDevelopmentWorkerMetadata({
      header: event.req.headers.get(DEVELOPMENT_WORKER_METADATA_HEADER),
      secret,
    });
    validateDevelopmentWorkerRuntimeRoot({
      appRoot,
      generationId: metadata.generationId,
      runtimeAppRoot: metadata.runtimeAppRoot,
    });
    event.req.headers.delete(DEVELOPMENT_WORKER_METADATA_HEADER);
    installDevelopmentWorkerRequestMetadata(event.req, metadata);
  });
}

function validateDevelopmentWorkerRuntimeRoot(input: {
  readonly appRoot: string;
  readonly generationId: string;
  readonly runtimeAppRoot: string;
}): void {
  if (basename(input.generationId) !== input.generationId) {
    throw new Error("Development worker generation id is invalid.");
  }

  const snapshotRoot = canonicalize(
    join(input.appRoot, ".eve", "dev-runtime", "snapshots", input.generationId),
  );
  const runtimeAppRoot = canonicalize(input.runtimeAppRoot);
  const relativePath = relative(snapshotRoot, runtimeAppRoot);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    throw new Error("Development worker runtime root is outside its generation.");
  }

  if (!existsSync(join(runtimeAppRoot, ".eve", "compile", "compiled-agent-manifest.json"))) {
    throw new Error(`Development worker generation "${input.generationId}" is incomplete.`);
  }
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readRequiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Development worker environment is missing ${name}.`);
  }
  return value;
}
