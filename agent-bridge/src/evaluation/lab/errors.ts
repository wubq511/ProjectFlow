export class EvaluationInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationInfrastructureError";
  }
}

export class EvaluationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationValidationError";
  }
}

export interface EvaluationBudgetUsage {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  cost?: number;
  output?: string;
}

export class EvaluationBudgetError extends Error {
  constructor(
    message: string,
    readonly usage?: EvaluationBudgetUsage,
  ) {
    super(message);
    this.name = "EvaluationBudgetError";
  }
}
