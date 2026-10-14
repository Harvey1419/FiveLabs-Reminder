export interface KapsoErrorOptions { status?: number; code?: string; data?: unknown }
export class KapsoError extends Error {
  status: number | undefined;
  code: string | undefined;
  data: unknown;
  constructor(message: string, { status, code, data }: KapsoErrorOptions = {}) {
    super(message);
    this.name = 'KapsoError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export class KapsoConfigurationError extends KapsoError {
  constructor(message: string) {
    super(message, { code: 'CONFIG_ERROR' });
    this.name = 'KapsoConfigurationError';
  }
}

export class KapsoAuthError extends KapsoError {
  constructor(message: string, status = 401) {
    super(message, { status, code: 'AUTH_ERROR' });
    this.name = 'KapsoAuthError';
  }
}

export class KapsoSandboxError extends KapsoError {
  constructor(message: string) {
    super(message, { status: 403, code: 'SANDBOX_EXPIRED' });
    this.name = 'KapsoSandboxError';
  }
}

export class KapsoRateLimitError extends KapsoError {
  constructor(message: string) {
    super(message, { status: 429, code: 'RATE_LIMIT' });
    this.name = 'KapsoRateLimitError';
  }
}

export class KapsoValidationError extends KapsoError {
  constructor(message: string, status = 400) {
    super(message, { status, code: 'VALIDATION_ERROR' });
    this.name = 'KapsoValidationError';
  }
}

