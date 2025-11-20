import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "crypto";

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const lambdaClient = new LambdaClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const RUNNER_FUNCTION_NAME = process.env.RUNNER_FUNCTION_NAME!;

export const handler = async (event: any) => {
  const method = event.httpMethod;
  const path = event.resource;

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };

  try {
    // 1. START TEST (POST /tests)
    if (method === "POST" && path === "/tests") {
      const body = JSON.parse(event.body || "{}");
      // FIX: Read outcome
      const { url, instructions, outcome } = body;
      const testId = randomUUID();

      await docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            id: testId,
            status: "RUNNING",
            url,
            // Optional: Store outcome in DB too for reference
            outcome: outcome || "N/A",
            createdAt: new Date().toISOString(),
          },
        })
      );

      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: RUNNER_FUNCTION_NAME,
          InvocationType: "Event",
          // FIX: Pass outcome to Runner
          Payload: JSON.stringify({ testId, url, instructions, outcome }),
        })
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ testId, status: "RUNNING" }),
      };
    }

    // 2. CHECK STATUS (GET /tests/{id})
    if (method === "GET" && event.pathParameters?.id) {
      const testId = event.pathParameters.id;

      const result = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { id: testId },
        })
      );

      if (!result.Item) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "Test not found" }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result.Item),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "Not Found" }),
    };
  } catch (error: any) {
    console.error(error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
