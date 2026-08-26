import type { RepositoryConfig } from "@/config/schema";

function repositoryFingerprint(repository: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of repository.toLowerCase()) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function sandboxNameForRepository(
  config: Pick<RepositoryConfig, "id" | "repository">,
): string {
  return `deepsec-${config.id}-${repositoryFingerprint(config.repository)}`;
}
