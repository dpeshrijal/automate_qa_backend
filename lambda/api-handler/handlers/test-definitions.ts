/**
 * Test Definitions API Handlers
 * Manages CRUD operations for reusable test cases
 */

import { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import type {
  TestDefinition,
  CreateTestDefinitionRequest,
  CreateTestDefinitionResponse,
  ListTestDefinitionsResponse,
} from "../types.js";

const TEST_DEFINITIONS_TABLE_NAME = process.env.TEST_DEFINITIONS_TABLE_NAME!;

/**
 * POST /test-definitions
 * Create a new test definition
 */
export async function createTestDefinition(
  docClient: DynamoDBDocumentClient,
  body: CreateTestDefinitionRequest
): Promise<CreateTestDefinitionResponse> {
  const { name, url, instructions, desiredOutcome } = body;

  // Validation
  if (!name || !url || !instructions || !desiredOutcome) {
    throw new Error("Missing required fields: name, url, instructions, desiredOutcome");
  }

  const now = new Date().toISOString();
  const testDefinition: TestDefinition = {
    id: randomUUID(),
    name,
    url,
    instructions,
    desiredOutcome,
    createdAt: now,
    updatedAt: now,
  };

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
 * List all test definitions
 */
export async function listTestDefinitions(
  docClient: DynamoDBDocumentClient
): Promise<ListTestDefinitionsResponse> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TEST_DEFINITIONS_TABLE_NAME,
    })
  );

  const testDefinitions = (result.Items || []) as TestDefinition[];

  // Sort by most recently updated first
  testDefinitions.sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
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
 * DELETE /test-definitions/{id}
 * Delete a test definition
 */
export async function deleteTestDefinition(
  docClient: DynamoDBDocumentClient,
  id: string
): Promise<{ message: string }> {
  await docClient.send(
    new DeleteCommand({
      TableName: TEST_DEFINITIONS_TABLE_NAME,
      Key: { id },
    })
  );

  return { message: "Test definition deleted successfully" };
}
