/**
 * 兼容入口：领域类型已统一收敛到 `shared/types.ts`（前后端共用）。
 * server 内部仍按原路径 `./types.ts` 导入，避免大范围改动。
 */
export type {
  CandidateLocator,
  FrameRef,
  LocatorStrategy,
  OperationWorkflow,
  Project,
  ProjectStatus,
  RecordedEvent,
  RecordingTrace,
  RunAccepted,
  RunRecord,
  ServerMessage,
  StepExecutionLog,
  StepProgress,
  StepRecovery,
  StepVerificationResult,
  StepVerificationRule,
  TargetEvidence,
  ViewportInfo,
  WorkflowCoverage,
  WorkflowActionType,
  WorkflowParameter,
  WorkflowStep,
  WorkflowStepCategory,
} from '../shared/types.ts'
