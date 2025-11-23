/**
 * Test Runs API Handlers
 * Manages test execution and status checking
 */

import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "crypto";
import type {
  TestRun,
  StartTestRunRequest,
  StartTestRunResponse,
} from "../types.js";

const TEST_RUNS_TABLE_NAME = process.env.TEST_RUNS_TABLE_NAME!;
const TEST_DEFINITIONS_TABLE_NAME = process.env.TEST_DEFINITIONS_TABLE_NAME!;
const RUNNER_FUNCTION_NAME = process.env.RUNNER_FUNCTION_NAME!;

const lambdaClient = new LambdaClient({});

/**
 * POST /tests
 * Start a new test run
 */
export async function startTestRun(
  docClient: DynamoDBDocumentClient,
  body: StartTestRunRequest
): Promise<StartTestRunResponse> {
  const { url, instructions, outcome, testDefinitionId } = body;

  // Validation
  if (!url || !instructions || !outcome) {
    throw new Error("Missing required fields: url, instructions, outcome");
  }

  const testId = randomUUID();
  const now = new Date().toISOString();

  // Create test run record
  const testRun: Partial<TestRun> = {
    id: testId,
    status: "RUNNING",
    url,
    outcome,
    testDefinitionId, // Optional link to saved test
    createdAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: TEST_RUNS_TABLE_NAME,
      Item: testRun,
    })
  );

  // Invoke test runner Lambda asynchronously
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: RUNNER_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({ testId, url, instructions, outcome }),
    })
  );

  // If this run is linked to a test definition, update the definition's last run info
  if (testDefinitionId) {
    await docClient.send(
      new UpdateCommand({
        TableName: TEST_DEFINITIONS_TABLE_NAME,
        Key: { id: testDefinitionId },
        UpdateExpression: "SET lastRunAt = :t, lastRunStatus = :s",
        ExpressionAttributeValues: {
          ":t": now,
          ":s": "RUNNING",
        },
      })
    );
  }

  return { testId, status: "RUNNING" };
}

/**
 * GET /tests/{id}
 * Get test run status and results
 */
export async function getTestRun(
  docClient: DynamoDBDocumentClient,
  testId: string
): Promise<TestRun> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TEST_RUNS_TABLE_NAME,
      Key: { id: testId },
    })
  );

  if (!result.Item) {
    throw new Error("Test not found");
  }

  // If test is complete and linked to a definition, update definition's last run status and screenshot
  const testRun = result.Item as TestRun;
  if (
    testRun.testDefinitionId &&
    (testRun.status === "COMPLETED" || testRun.status === "FAILED")
  ) {
    // Fire and forget - don't wait for this update
    docClient
      .send(
        new UpdateCommand({
          TableName: TEST_DEFINITIONS_TABLE_NAME,
          Key: { id: testRun.testDefinitionId },
          UpdateExpression: "SET lastRunStatus = :s, lastRunScreenshot = :scr",
          ExpressionAttributeValues: {
            ":s": testRun.status,
            ":scr": testRun.screenshot || null,
          },
        })
      )
      .catch((err) => console.error("Failed to update test definition:", err));
  }

  return testRun;
}
