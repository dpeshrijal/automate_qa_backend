/**
 * Test Definitions API Handlers
 * Manages CRUD operations for reusable test cases
 */

import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { randomUUID } from "crypto";
import type {
  TestDefinition,
  CreateTestDefinitionRequest,
  CreateTestDefinitionResponse,
  ListTestDefinitionsResponse,
} from "../types.js";

const TEST_DEFINITIONS_TABLE_NAME = process.env.TEST_DEFINITIONS_TABLE_NAME!;
const SCHEDULE_ROLE_ARN = process.env.SCHEDULE_ROLE_ARN!;

// Construct API Handler ARN from Lambda context
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_REGION_NAME!;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID!;
const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME!;
const API_HANDLER_ARN = `arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${FUNCTION_NAME}`;

const schedulerClient = new SchedulerClient({});

/**
 * Helper function to convert interval to EventBridge rate expression
 */
function getScheduleExpression(interval: string): string {
  const intervalMap: Record<string, string> = {
    "15m": "rate(15 minutes)",
    "30m": "rate(30 minutes)",
    "1h": "rate(1 hour)",
    "6h": "rate(6 hours)",
    "12h": "rate(12 hours)",
    "24h": "rate(24 hours)",
  };
  return intervalMap[interval] || "rate(1 hour)";
}

/**
 * POST /test-definitions
 * Create a new test definition
 */
export async function createTestDefinition(
  docClient: DynamoDBDocumentClient,
  body: CreateTestDefinitionRequest & { userId: string }
): Promise<CreateTestDefinitionResponse> {
  const { name, url, instructions, desiredOutcome, userId, isScheduled, scheduleInterval, slackWebhookUrl } = body;

  // Validation
  if (!name || !url || !instructions || !desiredOutcome) {
    throw new Error("Missing required fields: name, url, instructions, desiredOutcome");
  }

  if (!userId) {
    throw new Error("Missing userId");
  }

  if (isScheduled && !scheduleInterval) {
    throw new Error("scheduleInterval is required when isScheduled is true");
  }

  const now = new Date().toISOString();
  const testId = randomUUID();

  const testDefinition: TestDefinition = {
    id: testId,
    userId,
    name,
    url,
    instructions,
    desiredOutcome,
    createdAt: now,
    updatedAt: now,
    isScheduled: isScheduled || false,
    scheduleInterval: scheduleInterval,
    slackWebhookUrl: slackWebhookUrl,
  };

  // Create EventBridge schedule if needed
  if (isScheduled && scheduleInterval) {
    const scheduleName = `test-${testId}`;

    try {
      await schedulerClient.send(
        new CreateScheduleCommand({
          Name: scheduleName,
          ScheduleExpression: getScheduleExpression(scheduleInterval),
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: API_HANDLER_ARN,
            RoleArn: SCHEDULE_ROLE_ARN,
            Input: JSON.stringify({
              source: "eventbridge.scheduler",
              testDefinitionId: testId,
            }),
          },
        })
      );

      testDefinition.scheduleName = scheduleName;
    } catch (error: any) {
      console.error("Failed to create schedule:", error);
      throw new Error(`Failed to create schedule: ${error.message}`);
    }
  }

  await docClient.send(
    new PutCommand({
      TableName: TEST_DEFINITIONS_TABLE_NAME,
      Item: testDefinition,
    })
  );

  return { testDefinition };
}

/**
 * GET /test-definitions
 * List all test definitions for a specific user
 */
export async function listTestDefinitions(
  docClient: DynamoDBDocumentClient,
  userId: string
): Promise<ListTestDefinitionsResponse> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TEST_DEFINITIONS_TABLE_NAME,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
      ScanIndexForward: false,
    })
  );

  const testDefinitions = (result.Items || []) as TestDefinition[];

  // Sort by lastRunAt (most recent first), tests never run go to the bottom
  testDefinitions.sort((a, b) => {
    if (!a.lastRunAt && !b.lastRunAt) return 0;
    if (!a.lastRunAt) return 1; // a goes to bottom
    if (!b.lastRunAt) return -1; // b goes to bottom
    return new Date(b.lastRunAt).getTime() - new Date(a.lastRunAt).getTime();
  });

  return { testDefinitions };
}

/**
 * GET /test-definitions/{id}
 * Get a specific test definition
 */
export async function getTestDefinition(
  docClient: DynamoDBDocumentClient,
  id: string
): Promise<TestDefinition> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TEST_DEFINITIONS_TABLE_NAME,
      Key: { id },
    })
  );

  if (!result.Item) {
    throw new Error("Test definition not found");
  }

  return result.Item as TestDefinition;
}

/**
 * PUT /test-definitions/{id}
 * Update a test definition
 */
export async function updateTestDefinition(
  docClient: DynamoDBDocumentClient,
  id: string,
  body: Partial<CreateTestDefinitionRequest>
): Promise<{ testDefinition: TestDefinition }> {
  // Get existing test definition
  const existingTest = await getTestDefinition(docClient, id);

  const { name, url, instructions, desiredOutcome, isScheduled, scheduleInterval, slackWebhookUrl } = body;

  // Check if scheduling changed
  const wasScheduled = existingTest.isScheduled;
  const willBeScheduled = isScheduled !== undefined ? isScheduled : wasScheduled;
  const oldInterval = existingTest.scheduleInterval;
  const newInterval = scheduleInterval || oldInterval;

  // Handle schedule updates
  if (wasScheduled && !willBeScheduled && existingTest.scheduleName) {
    // Delete existing schedule
    try {
      await schedulerClient.send(
        new DeleteScheduleCommand({
          Name: existingTest.scheduleName,
        })
      );
    } catch (error: any) {
      console.error("Failed to delete schedule:", error);
    }
  } else if (!wasScheduled && willBeScheduled && newInterval) {
    // Create new schedule
    const scheduleName = `test-${id}`;
    try {
      await schedulerClient.send(
        new CreateScheduleCommand({
          Name: scheduleName,
          ScheduleExpression: getScheduleExpression(newInterval),
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: API_HANDLER_ARN,
            RoleArn: SCHEDULE_ROLE_ARN,
            Input: JSON.stringify({
              source: "eventbridge.scheduler",
              testDefinitionId: id,
            }),
          },
        })
      );
      existingTest.scheduleName = scheduleName;
    } catch (error: any) {
      console.error("Failed to create schedule:", error);
      throw new Error(`Failed to create schedule: ${error.message}`);
    }
  } else if (wasScheduled && willBeScheduled && oldInterval !== newInterval && existingTest.scheduleName && newInterval) {
    // Update existing schedule (delete and recreate)
    try {
      await schedulerClient.send(
        new DeleteScheduleCommand({
          Name: existingTest.scheduleName,
        })
      );

      await schedulerClient.send(
        new CreateScheduleCommand({
          Name: existingTest.scheduleName,
          ScheduleExpression: getScheduleExpression(newInterval),
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: API_HANDLER_ARN,
            RoleArn: SCHEDULE_ROLE_ARN,
            Input: JSON.stringify({
              source: "eventbridge.scheduler",
              testDefinitionId: id,
            }),
          },
        })
      );
    } catch (error: any) {
      console.error("Failed to update schedule:", error);
      throw new Error(`Failed to update schedule: ${error.message}`);
    }
  }

  // Update the test definition
  const updatedTest: TestDefinition = {
    ...existingTest,
    name: name || existingTest.name,
    url: url || existingTest.url,
    instructions: instructions || existingTest.instructions,
    desiredOutcome: desiredOutcome || existingTest.desiredOutcome,
    isScheduled: willBeScheduled,
    scheduleInterval: willBeScheduled ? newInterval : undefined,
    slackWebhookUrl: slackWebhookUrl !== undefined ? slackWebhookUrl : existingTest.slackWebhookUrl,
    updatedAt: new Date().toISOString(),
  };

  await docClient.send(
    new PutCommand({
      TableName: TEST_DEFINITIONS_TABLE_NAME,
      Item: updatedTest,
    })
  );

  return { testDefinition: updatedTest };
}

/**
 * DELETE /test-definitions/{id}
 * Delete a test definition
 */
export async function deleteTestDefinition(
  docClient: DynamoDBDocumentClient,
  id: string
): Promise<{ message: string }> {
  // First get the test to check if it has a schedule
  const testDef = await getTestDefinition(docClient, id);

  // Delete EventBridge schedule if it exists
  if (testDef.scheduleName) {
    try {
      await schedulerClient.send(
        new DeleteScheduleCommand({
          Name: testDef.scheduleName,
        })
      );
    } catch (error: any) {
      console.error("Failed to delete schedule:", error);
      // Continue with deletion even if schedule deletion fails
    }
  }

  await docClient.send(
    new DeleteCommand({
      TableName: TEST_DEFINITIONS_TABLE_NAME,
      Key: { id },
    })
  );

  return { message: "Test definition deleted successfully" };
}
