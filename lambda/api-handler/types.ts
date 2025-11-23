/**
 * Shared type definitions for the QA Automation Service
 */

/**
 * Test Definition - Reusable test template
 */
export interface TestDefinition {
  id: string;
  userId: string;
  name: string;
  url: string;
  instructions: string;
  desiredOutcome: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: "COMPLETED" | "FAILED" | "RUNNING";
}

/**
 * Test Run - Execution instance of a test
 */
export interface TestRun {
  id: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  url: string;
  outcome?: string;
  result?: string;
  screenshot?: string;
  history?: TestExecutionStep[];
  testDefinitionId?: string; // Link to parent test definition
  createdAt: string;
  updatedAt?: string;
  error?: string;
}

/**
 * Test Execution Step - Individual action taken during test
 */
export interface TestExecutionStep {
  action: string;
  target?: string;
  value?: string;
  success: boolean;
  timestamp: string;
}

/**
 * API Request/Response types
 */

export interface CreateTestDefinitionRequest {
  name: string;
  url: string;
  instructions: string;
  desiredOutcome: string;
}

export interface CreateTestDefinitionResponse {
  testDefinition: TestDefinition;
}

export interface ListTestDefinitionsResponse {
  testDefinitions: TestDefinition[];
}

export interface StartTestRunRequest {
  url: string;
  instructions: string;
  outcome: string;
  testDefinitionId?: string; // Optional link to saved test
}

export interface StartTestRunResponse {
  testId: string;
  status: string;
}
