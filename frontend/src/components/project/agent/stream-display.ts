export function executionStepStatusIcon(status: string): string {
  switch (status) {
    case "completed": return "✅";
    case "failed": return "❌";
    case "blocked": return "🚫";
    default: return "⏳";
  }
}
