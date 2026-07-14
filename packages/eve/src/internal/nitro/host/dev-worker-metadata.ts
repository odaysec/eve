import { createHmac, timingSafeEqual } from "node:crypto";

export const DEVELOPMENT_WORKER_METADATA_HEADER = "x-eve-dev-worker-metadata";
export const DEVELOPMENT_WORKER_APP_ROOT_ENV = "EVE_DEV_WORKER_APP_ROOT";
export const DEVELOPMENT_WORKER_TRANSPORT_SECRET_ENV = "EVE_DEV_WORKER_TRANSPORT_SECRET";

const DEVELOPMENT_WORKER_REQUEST_METADATA = Symbol.for("eve.dev.worker-request-metadata");

export interface DevelopmentWorkerMetadata {
  readonly clientAddress: string | null;
  readonly generationId: string;
  readonly runtimeAppRoot: string;
}

interface RequestWithDevelopmentWorkerMetadata extends Request {
  [DEVELOPMENT_WORKER_REQUEST_METADATA]?: DevelopmentWorkerMetadata;
}

export function encodeDevelopmentWorkerMetadata(input: {
  readonly metadata: DevelopmentWorkerMetadata;
  readonly secret: string;
}): string {
  const payload = Buffer.from(JSON.stringify(input.metadata), "utf8").toString("base64url");
  const signature = signDevelopmentWorkerMetadata(payload, input.secret);
  return `${payload}.${signature}`;
}

export function decodeDevelopmentWorkerMetadata(input: {
  readonly header: string | null;
  readonly secret: string;
}): DevelopmentWorkerMetadata {
  if (input.header === null) {
    throw new Error("Development worker request is missing trusted metadata.");
  }

  const separatorIndex = input.header.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === input.header.length - 1) {
    throw new Error("Development worker request metadata is malformed.");
  }

  const payload = input.header.slice(0, separatorIndex);
  const signature = input.header.slice(separatorIndex + 1);
  const expectedSignature = signDevelopmentWorkerMetadata(payload, input.secret);
  const received = Buffer.from(signature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");

  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Development worker request metadata is not trusted.");
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Development worker request metadata is malformed.");
  }

  if (!isDevelopmentWorkerMetadata(value)) {
    throw new Error("Development worker request metadata is malformed.");
  }

  return value;
}

export function installDevelopmentWorkerRequestMetadata(
  request: Request,
  metadata: DevelopmentWorkerMetadata,
): void {
  Object.defineProperty(request, DEVELOPMENT_WORKER_REQUEST_METADATA, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
}

export function readDevelopmentWorkerRequestMetadata(
  request: Request,
): DevelopmentWorkerMetadata | undefined {
  return (request as RequestWithDevelopmentWorkerMetadata)[DEVELOPMENT_WORKER_REQUEST_METADATA];
}

function signDevelopmentWorkerMetadata(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function isDevelopmentWorkerMetadata(value: unknown): value is DevelopmentWorkerMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    (record.clientAddress === null || typeof record.clientAddress === "string") &&
    typeof record.generationId === "string" &&
    record.generationId.length > 0 &&
    typeof record.runtimeAppRoot === "string" &&
    record.runtimeAppRoot.length > 0
  );
}
