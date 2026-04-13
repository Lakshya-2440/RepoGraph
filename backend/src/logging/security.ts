import type { Request } from "express";

export function getClientIp(request: Request): string {
  const forwarded = `${request.headers["x-forwarded-for"] ?? ""}`.split(",")[0].trim();
  return forwarded || request.socket.remoteAddress || "unknown";
}

export function sanitizeEmail(emailRaw: string | undefined): string | undefined {
  if (!emailRaw) {
    return undefined;
  }

  const email = emailRaw.trim().toLowerCase();
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) {
    return undefined;
  }

  return `${localPart.slice(0, 2)}***@${domain}`;
}

export function logSecurityEvent(event: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      scope: "security",
      event,
      timestamp: new Date().toISOString(),
      ...details
    })
  );
}

export function logAuthAttempt(event: string, request: Request, emailRaw?: string, error?: unknown): void {
  logSecurityEvent(event, {
    ip: getClientIp(request),
    method: request.method,
    path: request.path,
    email: sanitizeEmail(emailRaw),
    error: error instanceof Error ? error.message : undefined
  });
}

export function logApiError(request: Request, error: unknown, details: Record<string, unknown> = {}): void {
  logSecurityEvent("api_error", {
    ip: getClientIp(request),
    method: request.method,
    path: request.path,
    error: error instanceof Error ? error.message : undefined,
    ...details
  });
}