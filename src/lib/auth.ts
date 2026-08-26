import { timingSafeEqual } from "node:crypto";

export function isBearerAuthorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

