import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3"; // Import S3
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as path from "path";

export class AutomateQaBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. DynamoDB Tables
    // Test runs table - stores execution history
    const testRunsTable = new dynamodb.Table(this, "TestRunsTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Test definitions table - stores reusable test cases
    const testDefinitionsTable = new dynamodb.Table(
      this,
      "TestDefinitionsTable",
      {
        partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // Add GSI for userId queries
    testDefinitionsTable.addGlobalSecondaryIndex({
      indexName: "UserIdIndex",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Users table - stores user authentication data
    const usersTable = new dynamodb.Table(this, "UsersTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for email lookup
    usersTable.addGlobalSecondaryIndex({
      indexName: "EmailIndex",
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 2. S3 Bucket for Screenshots (NEW)
    const bucket = new s3.Bucket(this, "TestScreenshotsBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ["*"], // Allow Frontend to load image
          allowedHeaders: ["*"],
        },
      ],
    });

    const geminiApiKey = ssm.StringParameter.valueForStringParameter(
      this,
      "/automate-qa/gemini-api-key"
    );

    // 3. Browser Runner (Docker)
    const browserRunner = new lambda.DockerImageFunction(
      this,
      "BrowserRunner",
      {
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(__dirname, "../lambda/test-runner")
        ),
        timeout: cdk.Duration.seconds(900),
        memorySize: 3008,
        environment: {
          GEMINI_API_KEY: geminiApiKey,
          TEST_RUNS_TABLE_NAME: testRunsTable.tableName,
          BUCKET_NAME: bucket.bucketName,
          HOME: "/tmp",
        },
      }
    );

    // 4. API Handler (Node.js)
    const apiHandler = new nodejs.NodejsFunction(this, "ApiHandler", {
      entry: path.join(__dirname, "../lambda/api-handler/index.ts"),
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler",
      environment: {
        TEST_RUNS_TABLE_NAME: testRunsTable.tableName,
        TEST_DEFINITIONS_TABLE_NAME: testDefinitionsTable.tableName,
        USERS_TABLE_NAME: usersTable.tableName,
        RUNNER_FUNCTION_NAME: browserRunner.functionName,
      },
    });

    // 5. Permissions
    testRunsTable.grantReadWriteData(apiHandler);
    testRunsTable.grantReadWriteData(browserRunner);
    testDefinitionsTable.grantReadWriteData(apiHandler);
    usersTable.grantReadWriteData(apiHandler);
    browserRunner.grantInvoke(apiHandler);
    bucket.grantReadWrite(browserRunner);

    // 6. API Gateway
    const api = new apigateway.RestApi(this, "AutomateQAApi", {
      restApiName: "AutomateQA Service",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "X-User-Id"],
      },
    });

    // Gateway Responses for CORS on errors
    api.addGatewayResponse("GatewayResponseDefault4XX", {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers":
          "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-User-Id'",
        "Access-Control-Allow-Methods": "'OPTIONS,GET,POST,DELETE'",
      },
    });

    api.addGatewayResponse("GatewayResponseDefault5XX", {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers":
          "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-User-Id'",
        "Access-Control-Allow-Methods": "'OPTIONS,GET,POST,DELETE'",
      },
    });

    // 7. Define Resources

    // Test runs endpoints (existing)
    const tests = api.root.addResource("tests", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "X-User-Id"],
      },
    });
    tests.addMethod("POST", new apigateway.LambdaIntegration(apiHandler));

    const testStatus = tests.addResource("{id}", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "X-User-Id"],
      },
    });
    testStatus.addMethod("GET", new apigateway.LambdaIntegration(apiHandler));

    // Test definitions endpoints (new)
    const testDefinitions = api.root.addResource("test-definitions", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "X-User-Id"],
      },
    });
    testDefinitions.addMethod("POST", new apigateway.LambdaIntegration(apiHandler));
    testDefinitions.addMethod("GET", new apigateway.LambdaIntegration(apiHandler));

    const testDefinitionById = testDefinitions.addResource("{id}", {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "X-User-Id"],
      },
    });
    testDefinitionById.addMethod("GET", new apigateway.LambdaIntegration(apiHandler));
    testDefinitionById.addMethod("DELETE", new apigateway.LambdaIntegration(apiHandler));

    new cdk.CfnOutput(this, "ApiUrl", { value: api.url });
    new cdk.CfnOutput(this, "UsersTableName", { value: usersTable.tableName });
  }
}
