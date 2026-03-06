export { defineStep } from './define-step.js';
export { RunsheetError } from './errors.js';
export type { RunsheetErrorCode } from './errors.js';
export { buildPipeline } from './pipeline.js';
export type { Pipeline, PipelineConfig } from './pipeline.js';
export { when } from './when.js';
export type { ConditionalStep } from './when.js';
export { parallel } from './parallel.js';
export { choice } from './choice.js';
export { map } from './map.js';
export type { StepMiddleware, StepInfo, StepExecutor } from './middleware.js';
export { createPipeline } from './builder.js';
export type { PipelineBuilder } from './builder.js';

export type {
  Step,
  TypedStep,
  StepConfig,
  StepContext,
  StepOutput,
  ExtractRequires,
  ExtractProvides,
  RetryPolicy,
  PipelineResult,
  PipelineSuccess,
  PipelineFailure,
  PipelineExecutionMeta,
  RollbackReport,
  RollbackFailure,
} from './types.js';

// Re-export Result types so consumers never need to import composable-functions
export type { Result, Success, Failure } from 'composable-functions';
