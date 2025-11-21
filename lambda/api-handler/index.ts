/**
 * API Gateway Lambda Handler
 * Routes requests to appropriate handlers
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createTestDefinition,
  listTestDefinitions,
  getTestDefinition,
  deleteTestDefinition,
} from "./handlers/test-definitions.js";
import { startTestRun, getTestRun } from "./handlers/test-runs.js";

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const handler = async (event: any) => {
  const method = event.httpMethod;
  const path = event.resource;
  const pathParams = event.pathParameters;

  try {
    // ========================================
    // TEST DEFINITIONS ENDPOINTS
    // ========================================

    // POST /test-definitions - Create new test definition
    if (method === "POST" && path === "/test-definitions") {
      const body = JSON.parse(event.body || "{}");
      const result = await createTestDefinition(docClient, body);

      return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // GET /test-definitions - List all test definitions
    if (method === "GET" && path === "/test-definitions") {
      const result = await listTestDefinitions(docClient);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // GET /test-definitions/{id} - Get specific test definition
    if (method === "GET" && path === "/test-definitions/{id}" && pathParams?.id) {
      const result = await getTestDefinition(docClient, pathParams.id);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // DELETE /test-definitions/{id} - Delete test definition
    if (method === "DELETE" && path === "/test-definitions/{id}" && pathParams?.id) {
      const result = await deleteTestDefinition(docClient, pathParams.id);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // ========================================
    // TEST RUNS ENDPOINTS (existing)
    // ========================================

    // POST /tests - Start a new test run
    if (method === "POST" && path === "/tests") {
      const body = JSON.parse(event.body || "{}");
      const result = await startTestRun(docClient, body);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // GET /tests/{id} - Check test run status
    if (method === "GET" && path === "/tests/{id}" && pathParams?.id) {
      const result = await getTestRun(docClient, pathParams.id);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // Not Found
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Not Found" }),
    };
  } catch (error: any) {
    console.error("API Error:", error);

    return {
      statusCode: error.message.includes("not found") ? 404 : 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
