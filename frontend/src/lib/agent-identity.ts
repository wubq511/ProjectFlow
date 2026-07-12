export function resolveAgentActorId(
  currentUserId: string | null | undefined,
): string | null {
  const actorId = currentUserId?.trim();
  return actorId ? actorId : null;
}
