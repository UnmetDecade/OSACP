export class PcsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PcsError";
  }
}

export function badRequest(code: string, message: string, detail?: unknown): never {
  throw new PcsError(400, code, message, detail);
}

export function forbidden(code: string, message: string, detail?: unknown): never {
  throw new PcsError(403, code, message, detail);
}

export function notFound(code: string, message: string): never {
  throw new PcsError(404, code, message);
}

export function conflict(code: string, message: string, detail?: unknown): never {
  throw new PcsError(409, code, message, detail);
}
